#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

const output = process.argv[2];
if (!output) {
  console.error('Usage: node scripts/generate-agent-snapshot-benchmark.mjs OUTPUT.ndjson');
  process.exit(2);
}

const stream = createWriteStream(output, { encoding: 'utf8' });
const baseDay = Date.UTC(2025, 8, 13);
let generation = 1;
const writeCommit = async (org, offset) => {
  const row = {
    OrgId: org,
    SnapshotGeneration: generation++,
    SnapshotDays: [new Date(baseDay + (offset % 366) * 86_400_000).toISOString().slice(0, 10)],
    PublishedAt: '2026-09-13 20:00:00.000',
  };
  if (!stream.write(`${JSON.stringify(row)}\n`)) await once(stream, 'drain');
};

for (const organizations of [1, 20, 200]) {
  for (let org = 0; org < organizations; org += 1) {
    for (let commit = 0; commit < 100; commit += 1) {
      await writeCommit(`snapshot-scale-${organizations}-${String(org).padStart(3, '0')}`, commit);
    }
  }
}
for (let commit = 0; commit < 100_000; commit += 1) {
  await writeCommit('snapshot-scale-worst-100k', commit);
}
stream.end();
await once(stream, 'finish');
console.log(
  JSON.stringify({
    output,
    rows: generation - 1,
    organizationFixtures: [1, 20, 200],
    worstCaseCommits: 100_000,
  }),
);
