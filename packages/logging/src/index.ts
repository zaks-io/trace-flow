import {
  formatBaggage,
  formatTraceparent,
  generateSpanId,
  parseBaggage,
  parseTraceparent,
  validateSpanId,
  validateTraceId,
} from '@trace-flow/utils';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogRuntime = 'cloudflare-worker' | 'durable-object' | 'convex' | 'nextjs' | 'node';

export interface TraceContext {
  traceId?: string;
  requestId?: string;
  workflowId?: string;
  parentSpanId?: string;
  traceState?: string;
  traceFlags?: number;
  orgId?: string;
  userId?: string;
  sessionId?: string;
  baggage?: Record<string, string>;
}

export interface SerializedError {
  error_name?: string;
  error_message?: string;
  error_stack?: string;
}

export interface LogRecord extends SerializedError {
  ts: string;
  level: LogLevel;
  event: string;
  service: string;
  runtime: LogRuntime;
  component?: string;
  operation?: string;
  route?: string;
  method?: string;
  provider?: string;
  model?: string;
  trace_id?: string;
  request_id?: string;
  workflow_id?: string;
  parent_span_id?: string;
  org_id?: string;
  user_id?: string;
  session_id?: string;
  api_key_id?: string;
  cf_ray?: string;
  convex_function?: string;
  data?: Record<string, unknown>;
}

export interface LogContext extends TraceContext {
  component?: string;
  operation?: string;
  route?: string;
  method?: string;
  provider?: string;
  model?: string;
  apiKeyId?: string;
  cfRay?: string;
  convexFunction?: string;
  data?: Record<string, unknown>;
}

export interface Logger {
  child(context: LogContext): Logger;
  debug(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, error?: unknown, data?: Record<string, unknown>): void;
  flush(): Promise<void>;
}

export interface AxiomConfig {
  token: string;
  dataset: string;
  domain?: string;
}

export interface AxiomEnvLike {
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  AXIOM_DOMAIN?: string;
}

interface BatchTransport {
  enqueue(record: LogRecord): void;
  flush(): Promise<void>;
}

interface ConsoleLike {
  debug: (...data: unknown[]) => void;
  info: (...data: unknown[]) => void;
  warn: (...data: unknown[]) => void;
  error: (...data: unknown[]) => void;
}

export interface LoggerOptions {
  service: string;
  runtime: LogRuntime;
  component?: string;
  context?: LogContext;
  axiom?: AxiomConfig;
  emitToConsole?: boolean;
  console?: ConsoleLike;
}

export interface WorkerLoggerOptions extends Omit<LoggerOptions, 'runtime' | 'context'> {
  request: Request;
  runtime?: 'cloudflare-worker' | 'durable-object';
  context?: LogContext;
}

export interface ConvexLoggerOptions extends Omit<LoggerOptions, 'runtime'> {
  convexFunction?: string;
}

const DEFAULT_AXIOM_DATASET = 'cloudflare';
const DEFAULT_AXIOM_DOMAIN = 'api.axiom.co';
const KNOWN_BAGGAGE_KEYS = {
  request_id: 'requestId',
  workflow_id: 'workflowId',
  org_id: 'orgId',
  user_id: 'userId',
  session_id: 'sessionId',
} as const;

type BaggageKey = keyof typeof KNOWN_BAGGAGE_KEYS;
type KnownContextKey = (typeof KNOWN_BAGGAGE_KEYS)[BaggageKey];

function getHeader(
  headers: Headers | Record<string, string | undefined>,
  key: string,
): string | null {
  if (headers instanceof Headers) {
    return headers.get(key);
  }

  const direct = headers[key];
  if (direct) return direct;

  const lowercaseKey = key.toLowerCase();
  for (const [candidate, value] of Object.entries(headers)) {
    if (candidate.toLowerCase() === lowercaseKey && value) {
      return value;
    }
  }
  return null;
}

function compactRecord<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function normalizeContext(context?: LogContext): LogContext {
  if (!context) return {};

  return {
    ...context,
    traceId: validateTraceId(context.traceId) ?? undefined,
    parentSpanId: validateSpanId(context.parentSpanId) ?? undefined,
    baggage: context.baggage ? compactRecord(context.baggage) : undefined,
    data: context.data ? compactRecord(context.data) : undefined,
  };
}

function mergeContext(base: LogContext, next: LogContext): LogContext {
  return normalizeContext({
    ...base,
    ...next,
    baggage: {
      ...(base.baggage ?? {}),
      ...(next.baggage ?? {}),
    },
    data: {
      ...(base.data ?? {}),
      ...(next.data ?? {}),
    },
  });
}

function contextToRecordFields(context: LogContext): Partial<LogRecord> {
  return compactRecord({
    component: context.component,
    operation: context.operation,
    route: context.route,
    method: context.method,
    provider: context.provider,
    model: context.model,
    trace_id: context.traceId,
    request_id: context.requestId,
    workflow_id: context.workflowId,
    parent_span_id: context.parentSpanId,
    org_id: context.orgId,
    user_id: context.userId,
    session_id: context.sessionId,
    api_key_id: context.apiKeyId,
    cf_ray: context.cfRay,
    convex_function: context.convexFunction,
  });
}

function consoleMethodForLevel(level: LogLevel): keyof ConsoleLike {
  switch (level) {
    case 'debug':
      return 'debug';
    case 'info':
      return 'info';
    case 'warn':
      return 'warn';
    case 'error':
      return 'error';
  }
}

function normalizeDomain(domain?: string): string {
  if (!domain) return `https://${DEFAULT_AXIOM_DOMAIN}`;
  if (domain.startsWith('http://') || domain.startsWith('https://')) {
    return domain.replace(/\/+$/, '');
  }
  return `https://${domain.replace(/\/+$/, '')}`;
}

function buildAxiomUrl(config: AxiomConfig): string {
  const base = normalizeDomain(config.domain);
  return `${base}/v1/datasets/${encodeURIComponent(config.dataset)}/ingest`;
}

const MAX_BUFFER_SIZE = 1000;

function createBatchAxiomTransport(config: AxiomConfig): BatchTransport {
  const url = buildAxiomUrl(config);
  const buffer: LogRecord[] = [];
  let flushing: Promise<void> | null = null;

  async function doFlush(): Promise<void> {
    if (buffer.length === 0) return;

    const records = buffer.splice(0);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(records),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Axiom ingest failed: ${response.status} ${response.statusText} - ${body}`);
      }
    } catch (error) {
      buffer.unshift(...records);
      // Drop oldest records if buffer exceeds cap after restore
      if (buffer.length > MAX_BUFFER_SIZE) {
        buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
      }
      throw error;
    }
  }

  return {
    enqueue(record: LogRecord): void {
      if (buffer.length >= MAX_BUFFER_SIZE) {
        buffer.shift();
      }
      buffer.push(record);
    },
    async flush(): Promise<void> {
      while (flushing) {
        try {
          await flushing;
        } catch {
          // In-flight flush failed; we'll retry with our own doFlush
        }
      }
      flushing = doFlush();
      try {
        await flushing;
      } finally {
        flushing = null;
      }
    },
  };
}

function emitTransportFailure(
  sink: ConsoleLike,
  service: string,
  runtime: LogRuntime,
  error: unknown,
): void {
  const serializedError = serializeError(error);
  sink.error(
    JSON.stringify(
      compactRecord({
        ts: new Date().toISOString(),
        level: 'error',
        event: 'logger.axiom_ingest_failed',
        service,
        runtime,
        ...serializedError,
      }),
    ),
  );
}

function buildRecord(
  service: string,
  runtime: LogRuntime,
  level: LogLevel,
  event: string,
  context: LogContext,
  data?: Record<string, unknown>,
  error?: unknown,
): LogRecord {
  const serializedError = error === undefined ? {} : serializeError(error);
  const mergedData = compactRecord({
    ...(context.data ?? {}),
    ...(data ?? {}),
  });

  return compactRecord({
    ts: new Date().toISOString(),
    level,
    event,
    service,
    runtime,
    ...contextToRecordFields(context),
    ...serializedError,
    data: Object.keys(mergedData).length > 0 ? mergedData : undefined,
  });
}

export function createLogger(options: LoggerOptions): Logger {
  const baseContext = normalizeContext({
    component: options.component,
    ...(options.context ?? {}),
  });
  const transport = options.axiom ? createBatchAxiomTransport(options.axiom) : undefined;
  const sink = options.console ?? console;
  const emitToConsole = options.emitToConsole ?? true;

  const emit = (
    level: LogLevel,
    event: string,
    context: LogContext,
    data?: Record<string, unknown>,
    error?: unknown,
  ) => {
    const record = buildRecord(
      options.service,
      options.runtime,
      level,
      event,
      context,
      data,
      error,
    );
    if (emitToConsole) {
      sink[consoleMethodForLevel(level)](JSON.stringify(record));
    }
    transport?.enqueue(record);
  };

  const flush = async (): Promise<void> => {
    if (!transport) return;
    try {
      await transport.flush();
    } catch (error) {
      emitTransportFailure(sink, options.service, options.runtime, error);
    }
  };

  const makeLogger = (context: LogContext): Logger => ({
    child(nextContext: LogContext): Logger {
      return makeLogger(mergeContext(context, nextContext));
    },
    debug(event: string, data?: Record<string, unknown>): void {
      emit('debug', event, context, data);
    },
    info(event: string, data?: Record<string, unknown>): void {
      emit('info', event, context, data);
    },
    warn(event: string, data?: Record<string, unknown>): void {
      emit('warn', event, context, data);
    },
    error(event: string, error?: unknown, data?: Record<string, unknown>): void {
      emit('error', event, context, data, error);
    },
    flush,
  });

  return makeLogger(baseContext);
}

export function createWorkerLogger(options: WorkerLoggerOptions): Logger {
  const requestUrl = new URL(options.request.url);
  const requestTraceContext = traceContextFromHeaders(options.request.headers);
  const mergedContext = mergeContext(
    {
      ...requestTraceContext,
      cfRay: options.request.headers.get('cf-ray') ?? undefined,
      route: requestUrl.pathname,
      method: options.request.method,
    },
    options.context ?? {},
  );

  return createLogger({
    ...options,
    runtime: options.runtime ?? 'cloudflare-worker',
    context: mergedContext,
  });
}

export function createConvexLogger(options: ConvexLoggerOptions): Logger {
  return createLogger({
    ...options,
    runtime: 'convex',
    context: mergeContext(options.context ?? {}, {
      convexFunction: options.convexFunction,
    }),
  });
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return compactRecord({
      error_name: error.name,
      error_message: error.message,
      error_stack: error.stack,
    });
  }

  if (typeof error === 'string') {
    return { error_message: error };
  }

  if (error && typeof error === 'object') {
    const objectError = error as Record<string, unknown>;
    return compactRecord({
      error_name: typeof objectError.name === 'string' ? objectError.name : undefined,
      error_message:
        typeof objectError.message === 'string' ? objectError.message : JSON.stringify(error),
      error_stack: typeof objectError.stack === 'string' ? objectError.stack : undefined,
    });
  }

  return compactRecord({
    error_message:
      error === undefined ? undefined : typeof error === 'string' ? error : JSON.stringify(error),
  });
}

export function traceContextFromHeaders(
  headers: Headers | Record<string, string | undefined>,
): TraceContext {
  const traceparent = parseTraceparent(getHeader(headers, 'traceparent'));
  const traceState = getHeader(headers, 'tracestate') ?? undefined;
  const baggageEntries = parseBaggage(getHeader(headers, 'baggage'));
  const baggage = { ...baggageEntries };

  const knownContext: Partial<Pick<TraceContext, KnownContextKey>> = {};

  for (const [baggageKey, contextKey] of Object.entries(KNOWN_BAGGAGE_KEYS) as [
    BaggageKey,
    KnownContextKey,
  ][]) {
    const value = baggage[baggageKey];
    if (value) {
      knownContext[contextKey] = value;
      delete baggage[baggageKey];
    }
  }

  return compactRecord({
    traceId: traceparent?.traceId,
    parentSpanId: traceparent?.parentId,
    traceState,
    traceFlags: traceparent?.flags,
    ...knownContext,
    baggage: Object.keys(baggage).length > 0 ? baggage : undefined,
  });
}

export function traceContextToHeaders(traceContext: TraceContext, init?: HeadersInit): Headers {
  const headers = new Headers(init);
  const traceId = validateTraceId(traceContext.traceId);
  const parentSpanId = validateSpanId(traceContext.parentSpanId) ?? generateSpanId();

  if (traceId) {
    headers.set(
      'traceparent',
      formatTraceparent(traceId, parentSpanId, traceContext.traceFlags ?? 0x01),
    );
  }

  if (traceContext.traceState) {
    headers.set('tracestate', traceContext.traceState);
  }

  const baggageEntries = {
    ...parseBaggage(headers.get('baggage')),
    ...(traceContext.baggage ?? {}),
  };

  if (traceContext.requestId) baggageEntries.request_id = traceContext.requestId;
  if (traceContext.workflowId) baggageEntries.workflow_id = traceContext.workflowId;
  if (traceContext.orgId) baggageEntries.org_id = traceContext.orgId;
  if (traceContext.userId) baggageEntries.user_id = traceContext.userId;
  if (traceContext.sessionId) baggageEntries.session_id = traceContext.sessionId;

  if (Object.keys(baggageEntries).length > 0) {
    headers.set('baggage', formatBaggage(baggageEntries));
  }

  return headers;
}

export function axiomConfigFromEnv(env: AxiomEnvLike): AxiomConfig | undefined {
  if (!env.AXIOM_TOKEN) return undefined;

  return {
    token: env.AXIOM_TOKEN,
    dataset: env.AXIOM_DATASET ?? DEFAULT_AXIOM_DATASET,
    domain: env.AXIOM_DOMAIN,
  };
}

export function recordFromLogger(
  service: string,
  runtime: LogRuntime,
  level: LogLevel,
  event: string,
  context?: LogContext,
  data?: Record<string, unknown>,
  error?: unknown,
): LogRecord {
  return buildRecord(service, runtime, level, event, normalizeContext(context), data, error);
}
