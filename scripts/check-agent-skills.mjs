import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentSkillsDir = path.join(root, '.agents', 'skills');
const claudeSkillsDir = path.join(root, '.claude', 'skills');
const skillPrefix = 'trace-flow-';

const errors = [];

const relative = (target) => path.relative(root, target) || '.';
const fail = (message) => errors.push(message);

const listDirNames = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => entry.name);
  } catch (error) {
    fail(`Cannot read ${relative(dir)}: ${error.message}`);
    return [];
  }
};

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    fail(`Cannot read ${relative(file)}: ${error.message}`);
    return null;
  }
};

const readRealPath = (target) => {
  try {
    return realpathSync(target);
  } catch (error) {
    fail(`Cannot resolve ${relative(target)}: ${error.message}`);
    return null;
  }
};

const extractFrontmatterName = (skillFile) => {
  const text = readText(skillFile);
  if (!text) return null;

  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    fail(`${relative(skillFile)} is missing YAML frontmatter`);
    return null;
  }

  const nameMatch = match[1].match(/^name:\s*(.+)\s*$/m);
  if (!nameMatch) {
    fail(`${relative(skillFile)} is missing frontmatter name`);
    return null;
  }

  return nameMatch[1].trim().replace(/^["']|["']$/g, '');
};

const extractDefaultPrompt = (openaiFile) => {
  const text = readText(openaiFile);
  if (!text) return null;

  const match = text.match(/^\s*default_prompt:\s*(.+)\s*$/m);
  if (!match) {
    fail(`${relative(openaiFile)} is missing interface.default_prompt`);
    return null;
  }

  return match[1].trim().replace(/^["']|["']$/g, '');
};

const agentEntries = listDirNames(agentSkillsDir).sort();
const agentEntrySet = new Set(agentEntries);
const traceFlowSkillNames = agentEntries.filter((name) => name.startsWith(skillPrefix));

for (const name of traceFlowSkillNames) {
  const skillDir = path.join(agentSkillsDir, name);
  let stats;
  try {
    stats = lstatSync(skillDir);
  } catch (error) {
    fail(`Cannot inspect ${relative(skillDir)}: ${error.message}`);
    continue;
  }

  if (!stats.isDirectory()) {
    fail(`${relative(skillDir)} must be a canonical skill directory`);
    continue;
  }

  const skillFile = path.join(skillDir, 'SKILL.md');
  const frontmatterName = extractFrontmatterName(skillFile);
  if (frontmatterName && frontmatterName !== name) {
    fail(`${relative(skillFile)} name is ${frontmatterName}, expected ${name}`);
  }

  const openaiFile = path.join(skillDir, 'agents', 'openai.yaml');
  const defaultPrompt = extractDefaultPrompt(openaiFile);
  if (defaultPrompt && !defaultPrompt.includes(`$${name}`)) {
    fail(`${relative(openaiFile)} default_prompt must reference $${name}`);
  }
}

const claudeEntries = listDirNames(claudeSkillsDir).sort();
const claudeEntrySet = new Set(claudeEntries);

for (const name of agentEntries) {
  if (!claudeEntrySet.has(name)) {
    fail(`${relative(claudeSkillsDir)} is missing symlink ${name}`);
  }
}

for (const name of claudeEntries) {
  const claudePath = path.join(claudeSkillsDir, name);
  let stats;
  try {
    stats = lstatSync(claudePath);
  } catch (error) {
    fail(`Cannot inspect ${relative(claudePath)}: ${error.message}`);
    continue;
  }

  if (!agentEntrySet.has(name)) {
    fail(`${relative(claudePath)} has no matching .agents skill`);
    continue;
  }

  if (!stats.isSymbolicLink()) {
    fail(`${relative(claudePath)} must be a symlink to .agents/skills/${name}`);
    continue;
  }

  const expectedTarget = path.join('..', '..', '.agents', 'skills', name);
  const actualTarget = readlinkSync(claudePath);
  if (actualTarget !== expectedTarget) {
    fail(`${relative(claudePath)} points to ${actualTarget}, expected ${expectedTarget}`);
  }

  const expectedRealPath = readRealPath(path.join(agentSkillsDir, name));
  const actualRealPath = readRealPath(claudePath);
  if (actualRealPath && expectedRealPath && actualRealPath !== expectedRealPath) {
    fail(
      `${relative(claudePath)} resolves to ${relative(actualRealPath)}, expected ${relative(expectedRealPath)}`,
    );
  }
}

if (errors.length > 0) {
  console.error('Agent skill guard failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Agent skill guard passed (${traceFlowSkillNames.length} trace-flow skills, ${agentEntries.length} total skills).`,
);
