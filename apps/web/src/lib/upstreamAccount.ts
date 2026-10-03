import {
  IMPORTED_ACCOUNT_COVERAGE,
  SOURCE_IMPORTED_EXECUTION,
  SOURCE_PROXY,
} from '@trace-flow/otel-conventions';

export type AccountCoverage = (typeof IMPORTED_ACCOUNT_COVERAGE)[number];

export interface UpstreamAccount {
  key: string;
  installationId: string;
  provider: string;
  coverage: AccountCoverage;
  ref: string;
}

const IDENTITY_LABELS: Record<AccountCoverage, string> = {
  'provider-account': 'Verified account',
  credential: 'Credential',
  unknown: 'Identity unavailable',
};

const SHORT_ID_LENGTH = 8;

function isAccountCoverage(value: string): value is AccountCoverage {
  return (IMPORTED_ACCOUNT_COVERAGE as readonly string[]).includes(value);
}

/** Parses the installation/provider/coverage/ref key built in materialize_llm_request_facts. */
export function parseAccountKey(key: string): UpstreamAccount {
  const parts = key.split('/');
  const [installationId, provider, coverage, ref] = parts;
  if (parts.length !== 4 || !installationId || !provider || !isAccountCoverage(coverage)) {
    throw new Error(`Malformed upstream account key: ${key}`);
  }
  if ((coverage === 'unknown') !== (ref === '')) {
    throw new Error(`Upstream account key has inconsistent identity: ${key}`);
  }
  return { key, installationId, provider, coverage, ref };
}

export const UNRECOGNIZED_ACCOUNT_LABEL = 'Unrecognized account';

/**
 * For rendering: a key this build cannot parse (for example a coverage value added upstream
 * later) is shown as unrecognized in place instead of taking down the whole page.
 */
export function tryParseAccountKey(key: string): UpstreamAccount | null {
  try {
    return parseAccountKey(key);
  } catch {
    return null;
  }
}

export function identityLabel(coverage: AccountCoverage): string {
  return IDENTITY_LABELS[coverage];
}

export function installationLabel(account: UpstreamAccount): string {
  return `Installation ${account.installationId.slice(0, SHORT_ID_LENGTH)}`;
}

/**
 * Unknown identity is one bucket per installation and provider, so it is named after the
 * installation rather than presented as an account. Credentials keep their own noun so a
 * credential-level ref never reads as a verified account.
 */
export function accountLabel(account: UpstreamAccount): string {
  if (account.coverage === 'unknown') return installationLabel(account);
  const shortRef = account.ref.slice(0, SHORT_ID_LENGTH);
  return account.coverage === 'credential' ? `Credential ${shortRef}` : `Account ${shortRef}`;
}

/**
 * Dropdown and drawer label. Refs are only unique within an installation, so known identities
 * also name their installation; unknown buckets are already named after it.
 */
export function accountOptionLabel(account: UpstreamAccount): string {
  const details = [account.provider, identityLabel(account.coverage).toLowerCase()];
  if (account.coverage !== 'unknown') details.push(installationLabel(account).toLowerCase());
  return `${accountLabel(account)} (${details.join(', ')})`;
}

export interface AccountDrilldownFilters {
  provider?: string;
  model?: string;
  operation?: string;
  apiKey?: string;
}

export function accountRequestsHref(accountKey: string, filters: AccountDrilldownFilters): string {
  const params = new URLSearchParams({ account: accountKey });
  for (const [name, value] of Object.entries(filters)) {
    if (value) params.set(name, value);
  }
  return `/app/requests?${params.toString()}`;
}

const SOURCE_LABELS: Record<string, string> = {
  [SOURCE_IMPORTED_EXECUTION]: 'Local proxy',
  [SOURCE_PROXY]: 'Trace Flow proxy',
};

/** Unrecognized sources show their stored value rather than a guessed label. */
export function requestSourceLabel(source: string | undefined): string | null {
  if (!source) return null;
  return SOURCE_LABELS[source] ?? source;
}
