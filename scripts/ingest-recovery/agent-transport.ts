import type {
  BeginFactRebuildInput,
  BeginFactRebuildResult,
} from '../../apps/agent-consumer/src/fact-maintenance-contract';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { quote, DATASOURCES, type Row } from './agent-data';

export class AgentRecoveryClient {
  private tinybirdTokenFingerprints: string[] = [];
  private workspaceId?: string;
  private workspaceHost?: string;
  bindWorkspace(host: string, workspaceId: string, fingerprints: string[]) {
    this.workspaceId = workspaceId;
    this.workspaceHost = host;
    this.tinybirdTokenFingerprints = fingerprints;
  }
  get matchedWorkspaceId(): string | undefined {
    return this.workspaceId;
  }
  private executorId?: string;
  private assertExecutor?: () => void;
  bindExecutor(executorId: string, assertHeld: () => void) {
    this.executorId = executorId;
    this.assertExecutor = assertHeld;
  }
  constructor(
    readonly org: string,
    readonly url: string,
  ) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    ) {
      throw new Error('Recovery URL must be a local operator bridge');
    }
  }

  call(
    method: 'beginFactRebuild',
    options: Pick<BeginFactRebuildInput, 'operationId' | 'reason'>,
  ): Promise<BeginFactRebuildResult>;
  call(method: string, options: unknown): Promise<any>;
  async call(method: string, options: unknown): Promise<any> {
    if (['beginFactRebuild', 'listRebuildFacts', 'completeFactRebuild'].includes(method)) {
      this.assertExecutor?.();
      options = { ...(options as Record<string, unknown>), executorId: this.executorId };
    }
    if (method === 'beginFactRebuild')
      options = {
        ...(options as Record<string, unknown>),
        tinybirdTokenFingerprints: this.tinybirdTokenFingerprints,
        tinybirdWorkspaceId: this.workspaceId,
      };
    const request = {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipeline: 'agent',
        shardId: this.org,
        options,
        confirm: 'apply-recovery',
      }),
    } satisfies RequestInit;
    const attempts = ['listRecovery', 'listRebuildFacts'].includes(method) ? 3 : 1;
    let response: Response | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      this.assertExecutor?.();
      try {
        response = await fetch(`${this.url}/${method}`, {
          ...request,
          signal: AbortSignal.timeout(65_000),
        });
      } catch (error) {
        if (attempt === attempts) throw error;
      }
      if (response && ![502, 503, 504].includes(response.status)) break;
      if (attempt === attempts) break;
      await response?.body?.cancel();
      response = undefined;
      console.warn(`Retrying recovery read ${method} after a temporary connection failure`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
    if (!response) throw new Error(`Recovery ${method} returned no response`);
    if (!response.ok) throw new Error(`Recovery ${method} failed with HTTP ${response.status}`);
    const result = (await response.json()) as any;
    if (method === 'beginFactRebuild') {
      if (
        result.tinybirdHost !== this.workspaceHost ||
        !this.tinybirdTokenFingerprints.includes(result.tinybirdTokenFingerprint) ||
        this.workspaceId !== result.tinybirdWorkspaceId
      )
        throw new Error('Recovery consumer does not match the Tinybird workspace');
    }
    return result;
  }
}

export class AgentTinybirdClient {
  private token: string;
  readonly host: string;
  constructor(configPath: string) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (typeof config.token !== 'string' || !config.token || typeof config.host !== 'string') {
      throw new Error('Tinybird config must contain host and token');
    }
    this.host = config.host.replace(/\/$/, '');
    const url = new URL(this.host);
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      throw new Error('Remote Tinybird host requires HTTPS');
    }
    this.token = config.token;
  }

  async workspaceId(): Promise<string> {
    const result = await this.request('/v1/workspace');
    if (typeof result.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(result.id))
      throw new Error('Tinybird workspace identity is unavailable');
    return result.id;
  }

  async tokenFingerprints(): Promise<string[]> {
    const result = await this.request('/v0/tokens');
    if (!Array.isArray(result.tokens)) throw new Error('Workspace token listing is unavailable');
    const fingerprints = [
      ...new Set<string>(
        result.tokens
          .filter((entry: any) => typeof entry.token === 'string' && entry.token)
          .map((entry: any) => createHash('sha256').update(entry.token).digest('hex')),
      ),
    ];
    if (!fingerprints.length || fingerprints.length > 1024)
      throw new Error('Workspace token proof is empty or exceeds the supported bound');
    return fingerprints;
  }

  async request(path: string, body?: BodyInit): Promise<any> {
    const response = await fetch(this.host + path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${this.token}` },
      body,
      signal: AbortSignal.timeout(65_000),
    });
    if (!response.ok)
      throw new Error(`Tinybird ${path.split('?')[0]} failed with HTTP ${response.status}`);
    return response.json();
  }

  async sql(query: string): Promise<{ data: Row[]; meta: { name: string; type: string }[] }> {
    return this.request('/v0/sql', new URLSearchParams({ q: `${query} FORMAT JSON` }));
  }

  async *rows(table: string, org: string, keys: string[]): AsyncGenerator<Row> {
    let after: string | null = null;
    const tuple = `tuple(${keys.join(',')})`;
    while (true) {
      const condition = `OrgId=${quote(org)}${after ? ` AND ${tuple}>${after}` : ''}`;
      const page = await this.sql(
        `SELECT DISTINCT ${keys.join(',')} FROM ${table} WHERE ${condition} ORDER BY ${keys.join(',')} LIMIT 500`,
      );
      if (!page.data.length) return;
      const tuples = page.data.map(
        (row) => `tuple(${keys.map((key) => quote(String(row[key]))).join(',')})`,
      );
      const result = await this.sql(
        `SELECT * FROM ${table} WHERE OrgId=${quote(org)} AND ${tuple} IN (${tuples.join(',')}) ORDER BY ${keys.join(',')},IngestedAt`,
      );
      for (const row of result.data) yield row;
      after = tuples.at(-1)!;
    }
  }

  async graph(
    factTables: string[],
    repoRoot: string,
  ): Promise<{ facts: string[]; derived: string[]; definitionHashInput: string }> {
    const { datasources } = await this.request('/v0/datasources');
    const existing = new Set<string>(datasources.map((table: any) => table.name));
    const facts = factTables.filter((name) => existing.has(name));
    const touched = new Set(facts);
    const derived = new Set<string>();
    const { pipes } = await this.request('/v0/pipes');
    const expectedNames = readdirSync(resolve(repoRoot, 'materializations'))
      .filter((name) => name.startsWith('materialize_agent_') && name.endsWith('.pipe'))
      .map((name) => name.slice(0, -5));
    const deployedNames = new Set(
      pipes.filter((pipe: any) => pipe.type === 'materialized').map((pipe: any) => pipe.name),
    );
    for (const name of expectedNames) {
      if (!deployedNames.has(name))
        throw new Error(`Missing deployed agent materialization: ${name}`);
    }
    for (const name of Object.values(DATASOURCES)) {
      if (!facts.includes(name)) throw new Error(`Missing canonical table ${name}`);
    }

    const definitions: string[] = [];
    for (const pipe of pipes.filter((pipe: any) => pipe.type === 'materialized')) {
      const content = String(pipe.content);
      const sql = pipe.nodes.map((node: any) => node.sql).join('\n');
      const sources = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z_0-9]*)/gi)].map(
        (match) => match[1]!,
      );
      if (!sources.some((source) => touched.has(source))) continue;
      const target = /^DATASOURCE\s+(\w+)\s*$/m.exec(content)?.[1];
      if (!target || !existing.has(target) || sources.some((source) => !facts.includes(source))) {
        throw new Error(`Unsupported materialization dependency: ${pipe.name}`);
      }
      const local = readFileSync(
        resolve(repoRoot, 'materializations', `${pipe.name}.pipe`),
        'utf8',
      );
      if (local.trim() !== content.trim())
        throw new Error(`Deployed materialization differs from this checkout: ${pipe.name}`);
      derived.add(target);
      definitions.push(content);
    }
    // The current agent graph is one level. Refuse future chains until every upstream producer is handled.
    for (const pipe of pipes.filter((pipe: any) => pipe.type === 'materialized')) {
      if (
        [...derived].some((source) =>
          new RegExp(`\\b(?:FROM|JOIN)\\s+${source}\\b`, 'i').test(
            pipe.nodes.map((node: any) => node.sql).join('\n'),
          ),
        )
      ) {
        throw new Error(`Chained materialization requires a reviewed rebuild order: ${pipe.name}`);
      }
    }
    return {
      facts,
      derived: [...derived].sort(),
      definitionHashInput: definitions.sort().join('\n'),
    };
  }

  async waitJob(id: string): Promise<void> {
    for (let attempt = 0; attempt < 360; attempt++) {
      const result = await this.request(`/v0/jobs/${encodeURIComponent(id)}`);
      if (result.status === 'done') return;
      if (!['waiting', 'working'].includes(result.status))
        throw new Error(`Delete job ${id} is ${result.status}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Delete job ${id} still running; resume with the same operation`);
  }
}

export function normalized(row: Row, columns: { name: string; type: string }[]): Row {
  return Object.fromEntries(
    columns.map(({ name, type }) => {
      if (!(name in row))
        throw new Error(
          `Fact is missing stored column ${name}; replay the current collector before rebuilding`,
        );
      let value = row[name];
      if (/^(?:U?Int64|U?Int128|U?Int256)$/.test(type)) value = String(value);
      if (type.startsWith('DateTime')) {
        const milliseconds = Date.parse(
          String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z'),
        );
        if (!Number.isFinite(milliseconds)) throw new Error(`Invalid ${name}`);
        value = new Date(milliseconds).toISOString();
      }
      return [name, value];
    }),
  );
}
