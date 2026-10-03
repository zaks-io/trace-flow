import { describe, expect, it } from 'vitest';
import { CLI_PROXY } from '@trace-flow/otel-conventions';
import vectors from '../../../../../fixtures/cliproxyapi-account-identity-v1.json';
import executions from '../../../../../fixtures/cliproxyapi-execution-v2.json';
import { validateImportedExecutionRequest } from '../imported/validate';
import type { OTLPExportTraceServiceRequest } from '../types';

interface Evidence {
  family?: string;
  provider_key?: string;
  auth_id?: string;
  provider_account?: Record<string, string>;
}

interface IdentityVector {
  name: string;
  installation: string;
  evidence: Evidence;
  coverage: string;
  id: string | null;
  ref: string | null;
}

const identity = vectors as {
  installation_secrets_hex: Record<string, string>;
  cases: IdentityVector[];
  distinct: string[][];
  equal: string[][];
};

// Reference resolver for the shared vectors; the exporter owns the production implementation.
const PROVIDER_ACCOUNT_FIELDS: Record<string, readonly string[]> = {
  codex: ['workspace_account_id', 'member_user_id'],
  claude: ['organization_uuid', 'account_uuid'],
};

const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function present(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && !LONE_SURROGATE.test(value);
}

function resolve(evidence: Evidence): { coverage: string; id?: string } {
  const account = evidence.provider_account ?? {};
  const fields = PROVIDER_ACCOUNT_FIELDS[evidence.family ?? ''];
  const accountIds = fields?.map((field) => account[field]);
  if (accountIds?.every(present)) {
    return {
      coverage: 'provider-account',
      id: JSON.stringify(['provider-account/1', evidence.family, ...accountIds]),
    };
  }
  const fallback = [evidence.family, evidence.provider_key, evidence.auth_id];
  if (fallback.every(present)) {
    return { coverage: 'credential', id: JSON.stringify(['credential/1', ...fallback]) };
  }
  return { coverage: 'unknown' };
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!, (byte) => Number.parseInt(byte, 16));
}

async function accountRef(secretHex: string, coverage: string, id: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    hexToBytes(secretHex),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = new TextEncoder().encode(`${coverage}\0${id}`);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function caseNamed(name: string) {
  const found = identity.cases.find((entry) => entry.name === name);
  if (!found) throw new Error(`Identity vector missing: ${name}`);
  return found;
}

function exportWithAccount(coverage: string, ref: string | null): OTLPExportTraceServiceRequest {
  const request: OTLPExportTraceServiceRequest = structuredClone(executions);
  const span = request.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
  span.attributes = span.attributes!.filter(
    (attribute) =>
      attribute.key !== CLI_PROXY.ACCOUNT_COVERAGE && attribute.key !== CLI_PROXY.ACCOUNT_REF,
  );
  span.attributes.push({ key: CLI_PROXY.ACCOUNT_COVERAGE, value: { stringValue: coverage } });
  if (ref !== null) {
    span.attributes.push({ key: CLI_PROXY.ACCOUNT_REF, value: { stringValue: ref } });
  }
  return request;
}

describe('CLIProxyAPI account identity vectors', () => {
  it.each(identity.cases.map((entry) => [entry.name, entry] as const))(
    '%s derives the published id bytes and reference',
    async (_name, entry) => {
      const resolved = resolve(entry.evidence);
      expect(resolved.coverage).toBe(entry.coverage);
      expect(resolved.id ?? null).toBe(entry.id);
      if (resolved.id === undefined) {
        expect(entry.ref).toBeNull();
        return;
      }
      const secret = identity.installation_secrets_hex[entry.installation]!;
      expect(await accountRef(secret, resolved.coverage, resolved.id)).toBe(entry.ref);
    },
  );

  it.each(identity.distinct)('separates %s from %s', (left, right) => {
    expect(caseNamed(left).ref).not.toBeNull();
    expect(caseNamed(left).ref).not.toBe(caseNamed(right).ref);
  });

  it.each(identity.equal)('keeps %s grouped with %s', (left, right) => {
    expect(caseNamed(left).ref).not.toBeNull();
    expect(caseNamed(left).ref).toBe(caseNamed(right).ref);
  });

  it('separates two members of one Codex workspace under provider-account coverage', () => {
    const memberA = caseNamed('codex-workspace-member-a');
    const memberB = caseNamed('codex-workspace-member-b');
    expect(memberA.evidence.provider_account?.workspace_account_id).toBe(
      memberB.evidence.provider_account?.workspace_account_id,
    );
    expect([memberA.coverage, memberB.coverage]).toEqual(['provider-account', 'provider-account']);
    expect(memberA.ref).not.toBe(memberB.ref);
  });

  it.each(identity.cases.map((entry) => [entry.name, entry] as const))(
    '%s is accepted by the v2 receiver with its coverage',
    (_name, entry) => {
      expect(
        validateImportedExecutionRequest(exportWithAccount(entry.coverage, entry.ref)),
      ).toMatchObject({ valid: true });
    },
  );
});
