export const IMPORTED_EXECUTION = {
  SCOPE_NAME: 'cliproxyapi.execution',
  SCOPE_VERSION: '2',
  CONTRACT: 'cliproxyapi.execution/2',
  SOURCE: 'imported_execution',
  MAX_DURATION_NS: 24n * 60n * 60n * 1_000_000_000n,
  MAX_TOTAL_TOKENS: 4_294_967_295,
} as const;

export const IMPORTED_ACCOUNT_COVERAGE = ['provider-account', 'credential', 'unknown'] as const;
export const IMPORTED_USAGE_QUALITY = ['complete', 'inconsistent', 'unclassified'] as const;
