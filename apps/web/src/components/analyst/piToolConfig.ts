import {
  Database,
  FileSearch,
  FileText,
  FilePlus2,
  FolderOpen,
  FolderSearch,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

type PiToolConfig = {
  icon: LucideIcon;
  /** Tailwind text-color class for the icon — drawn from the on-brand chart palette. */
  accent: string;
  label: string;
};

/**
 * Closed config for the Analyst's two tool surfaces:
 *  - the Pi coding-agent's own tools (`read`/`write`/`bash`/`grep`/`find`/`ls`/`traceflow_data`),
 *    grounded in apps/analyst-sandbox/src/piRunner.ts.
 *  - the Analyst model's tools (`start_pi_agent_analysis`, `control_pi_agent_run`).
 * No generic catch-all entries — every real tool is named here.
 */
const PI_TOOL_CONFIG: Record<string, PiToolConfig> = {
  read: { icon: FileText, accent: 'text-chart-8', label: 'Read' },
  write: { icon: FilePlus2, accent: 'text-chart-8', label: 'Write' },
  bash: { icon: Terminal, accent: 'text-chart-2', label: 'Run' },
  grep: { icon: FileSearch, accent: 'text-chart-5', label: 'Search' },
  find: { icon: FolderSearch, accent: 'text-chart-5', label: 'Find' },
  ls: { icon: FolderOpen, accent: 'text-chart-3', label: 'List' },
  traceflow_data: { icon: Database, accent: 'text-chart-1', label: 'Data query' },
  start_pi_agent_analysis: { icon: Sparkles, accent: 'text-chart-1', label: 'Analysis' },
  control_pi_agent_run: { icon: Square, accent: 'text-chart-4', label: 'Run control' },
};

const DEFAULT_CONFIG: PiToolConfig = {
  icon: Wrench,
  accent: 'text-muted-foreground',
  label: 'Tool',
};

export function getPiToolConfig(toolName: string | undefined): PiToolConfig {
  if (!toolName) return DEFAULT_CONFIG;
  return (
    PI_TOOL_CONFIG[toolName] ?? PI_TOOL_CONFIG[toolName.replace(/^tool-/, '')] ?? DEFAULT_CONFIG
  );
}

/**
 * A short, human inline preview for a tool row: the config label plus the most
 * meaningful argument (a basename'd path, a command, or a data-API operation).
 */
export function formatPiToolLabel(toolName: string | undefined, command?: string): string {
  const { label } = getPiToolConfig(toolName);
  const preview = command ? basenameIfPath(command) : undefined;
  return preview ? `${label} · ${preview}` : label;
}

function basenameIfPath(value: string): string {
  if (!value.includes('/') || value.includes(' ')) return value;
  const segments = value.split('/').filter(Boolean);
  return segments.at(-1) ?? value;
}
