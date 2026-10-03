export const IMPORTED_EXECUTION = {
  SCOPE_NAME: 'cliproxyapi.execution',
  SCOPE_VERSION: '2',
  CONTRACT: 'cliproxyapi.execution/2',
  SOURCE: 'imported_execution',
  MAX_DURATION_NS: 24n * 60n * 60n * 1_000_000_000n,
  MAX_TOTAL_TOKENS: 4_294_967_295,
} as const;

export const IMPORTED_ACCOUNT_COVERAGE = ['provider-account', 'credential', 'unknown'] as const;
// Subscription tier the exporter read from the upstream account; a closed set so a typo or a new
// tier fails validation instead of silently becoming an unpriced label.
export const IMPORTED_ACCOUNT_PLANS = [
  'claude_pro',
  'claude_max_5x',
  'claude_max_20x',
  'chatgpt_free',
  'chatgpt_plus',
  'chatgpt_pro',
  'chatgpt_team',
  'chatgpt_enterprise',
  'unknown',
] as const;
export type ImportedAccountPlan = (typeof IMPORTED_ACCOUNT_PLANS)[number];

export const IMPORTED_USAGE_QUALITY = ['complete', 'inconsistent', 'unclassified'] as const;

export const IMPORTED_CLIENT_SOURCES = ['claude', 'codex'] as const;
