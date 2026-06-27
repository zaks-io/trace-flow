/**
 * Generates `traceflow_client.py` from the same approved tool definitions that
 * build the sandbox OpenAPI document. One registry, two renderers: keeping the
 * generator here (rather than hand-writing a Python SDK) means the client's typed
 * signatures and the OpenAPI spec can never drift from the tool schemas.
 *
 * The generated file is a static Python runtime (HTTP + paging + DataFrame +
 * pydantic validation) plus one thin method per tool. The method bodies are
 * mechanical, so the only per-tool knowledge encoded here is the JSON Schema →
 * Python type/signature mapping.
 */

interface JsonSchema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

interface ToolDefinitionLike {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
}

const PYTHON_RESERVED = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

function toolName(definition: ToolDefinitionLike): string | undefined {
  return typeof definition.name === 'string' && definition.name ? definition.name : undefined;
}

function inputSchema(definition: ToolDefinitionLike): JsonSchema {
  const schema = definition.inputSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  return schema;
}

function isValidIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !PYTHON_RESERVED.has(name);
}

function primitiveType(type: string | undefined): string {
  switch (type) {
    case 'integer':
      return 'int';
    case 'number':
      return 'float';
    case 'boolean':
      return 'bool';
    case 'string':
      return 'str';
    case 'object':
      return 'dict';
    default:
      return 'Any';
  }
}

/** JSON Schema property → Python type hint. Arrays become typed lists; everything else maps to a scalar. */
function pythonType(schema: JsonSchema): string {
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  if (type === 'array') {
    const item = schema.items ? primitiveType(typeOf(schema.items)) : 'Any';
    return `list[${item}]`;
  }
  return primitiveType(type);
}

function typeOf(schema: JsonSchema): string | undefined {
  return Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
}

function escapePyString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}

interface GeneratedParam {
  name: string;
  type: string;
  required: boolean;
  description: string;
  enumValues: string[];
}

/** Enum choices for a param, including array-of-enum (items.enum), rendered as strings for the docstring. */
function enumValues(prop: JsonSchema): string[] {
  const source = Array.isArray(prop.enum)
    ? prop.enum
    : prop.items && Array.isArray(prop.items.enum)
      ? prop.items.enum
      : [];
  return source.filter((value): value is string => typeof value === 'string');
}

function toolParams(schema: JsonSchema): GeneratedParam[] {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const params: GeneratedParam[] = [];
  for (const [name, prop] of Object.entries(properties)) {
    if (!isValidIdentifier(name)) continue;
    params.push({
      name,
      type: pythonType(prop),
      required: required.has(name),
      description: typeof prop.description === 'string' ? prop.description : '',
      enumValues: enumValues(prop),
    });
  }
  // Required params first so the Python signature is valid (no required after optional).
  return params.sort((a, b) => Number(b.required) - Number(a.required));
}

/** Cache-control param appended to every method. `refresh` collides with no current tool; guarded below. */
function refreshParam(params: GeneratedParam[]): string {
  return params.some((p) => p.name === 'refresh') ? 'refresh_cache' : 'refresh';
}

function methodSignature(params: GeneratedParam[], refresh: string): string {
  // Every method is keyword-only (it always has at least the refresh flag), so the
  // bare `*` separator is always safe here.
  const parts = ['self', '*'];
  for (const param of params) {
    parts.push(
      param.required
        ? `${param.name}: ${param.type}`
        : `${param.name}: ${param.type} | None = None`,
    );
  }
  parts.push(`${refresh}: bool = False`);
  return parts.join(', ');
}

function pydanticModel(name: string, params: GeneratedParam[]): string {
  const className = `${pascalCase(name)}Args`;
  const lines = [`class ${className}(BaseModel):`, '    model_config = ConfigDict(extra="forbid")'];
  if (params.length === 0) {
    lines.push('    pass');
  }
  for (const param of params) {
    const annotation = param.required ? param.type : `${param.type} | None`;
    const fieldArgs = param.description
      ? `Field(${param.required ? '...' : 'None'}, description="${escapePyString(param.description)}")`
      : param.required
        ? '...'
        : 'None';
    lines.push(`    ${param.name}: ${annotation} = ${fieldArgs}`);
  }
  return lines.join('\n');
}

function pascalCase(name: string): string {
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** Wrap a long sentence to keep docstrings readable at ~88 cols, indented as a docstring body. */
function wrap(text: string, indent: string, width = 88): string[] {
  const words = escapePyString(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = indent;
  for (const word of words) {
    if (current !== indent && `${current} ${word}`.length > width) {
      lines.push(current);
      current = `${indent}${word}`;
    } else {
      current = current === indent ? `${indent}${word}` : `${current} ${word}`;
    }
  }
  lines.push(current);
  return lines;
}

/** Shared Args: block describing each param's type, required-ness, enum choices, and the cache flag. */
function argsBlock(params: GeneratedParam[], refresh: string): string[] {
  const lines = ['', '        Args:'];
  for (const param of params) {
    const req = param.required ? 'required' : 'optional';
    const desc = param.description.trim();
    const sep = desc && !/[.!?]$/.test(desc) ? '.' : '';
    const choices = param.enumValues.length ? ` One of: ${param.enumValues.join(', ')}.` : '';
    const detail = `${param.name} (${param.type}, ${req}): ${desc}${sep}${choices}`.trim();
    lines.push(...wrap(detail, '            '));
  }
  lines.push(
    ...wrap(
      `${refresh} (bool, optional): bypass the per-run cache and re-fetch live data.`,
      '            ',
    ),
  );
  return lines;
}

function methodSource(name: string, description: string, params: GeneratedParam[]): string {
  const className = `${pascalCase(name)}Args`;
  const refresh = refreshParam(params);
  const signature = methodSignature(params, refresh);
  const args = argsBlock(params, refresh);
  const assignments = params.length ? params.map((p) => `${p.name}=${p.name}`).join(', ') : '';
  return [
    `    def ${name}(${signature}) -> "pd.DataFrame":`,
    '        """',
    ...wrap(description, '        '),
    ...args,
    '',
    '        Returns:',
    '            pandas.DataFrame: all rows for the query, fetched across every page. The',
    '            DataFrame is empty when the query matches nothing. For results that are a',
    `            single summary object rather than a row collection, use ${name}_raw instead.`,
    '',
    '        Caching:',
    `            The result is cached to disk per run for 5 minutes, so repeating this call is`,
    `            free and does not re-hit the database. Pass ${refresh}=True to force fresh data.`,
    '        """',
    `        args = ${className}(${assignments}).model_dump(exclude_none=True)`,
    `        return self._call_df(${JSON.stringify(name)}, args, refresh=${refresh})`,
    '',
    `    def ${name}_raw(${signature}) -> Any:`,
    '        """',
    ...wrap(
      `${description} Returns the decoded JSON exactly as the API returns it (a single page, not flattened into a DataFrame). Use this for summary/object results; use ${name} when you want a DataFrame of rows.`,
      '        ',
    ),
    ...args,
    '',
    '        Caching:',
    `            Cached to disk per run for 5 minutes; pass ${refresh}=True to force fresh data.`,
    '        """',
    `        args = ${className}(${assignments}).model_dump(exclude_none=True)`,
    `        return self._call_raw(${JSON.stringify(name)}, args, refresh=${refresh})`,
    '',
  ].join('\n');
}

/** Static Python runtime shared by every generated method. Holds the HTTP, paging, and DataFrame logic. */
function runtimeBase(): string {
  return String.raw`"""Trace Flow sandbox data client (generated — do not edit).

Typed access to the approved Trace Flow tools for this run. Methods return pandas
DataFrames and page automatically; *_raw variants return decoded JSON for a single
page (use these for summary/object results that are not row collections).

Every result is cached to disk per run (5 min TTL) so you can re-run and iterate
without re-hitting the database. Pass refresh=True to bypass the cache and fetch
live data.

    from traceflow_client import tf
    df = tf.list_traces(hours=168, limit=200)              # auto-paged, cached DataFrame
    df = tf.list_traces(hours=168, limit=200, refresh=True) # force a fresh fetch
    summary = tf.get_usage_summary_raw(hours=168)          # single JSON object
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from typing import Any

import pandas as pd
from pydantic import BaseModel, ConfigDict, Field

_RUN_ID = os.environ.get("TRACEFLOW_RUN_ID", "")
_DESCRIPTOR_PATH = os.environ.get(
    "TRACEFLOW_DATA_API_DESCRIPTOR",
    "/workspace/runs/" + _RUN_ID + "/traceflow-data-api.json",
)
_CACHE_DIR = os.environ.get(
    "TRACEFLOW_DATA_CACHE_DIR", "/workspace/runs/" + _RUN_ID + "/cache"
)
_CACHE_TTL_SECONDS = 300
_MAX_PAGES = 1000


def _resolve_base_url() -> str:
    explicit = os.environ.get("TRACEFLOW_DATA_API_BASE_URL")
    if explicit:
        return explicit.rstrip("/")
    try:
        with open(_DESCRIPTOR_PATH, "r", encoding="utf-8") as handle:
            descriptor = json.load(handle)
        base = descriptor.get("baseUrl")
        if isinstance(base, str) and base:
            return base.rstrip("/")
    except (OSError, ValueError):
        pass
    raise RuntimeError(
        "Trace Flow Data API base URL not found. Set TRACEFLOW_DATA_API_BASE_URL or ensure "
        + _DESCRIPTOR_PATH
        + " exists."
    )


def _cache_key(kind: str, tool_name: str, args: dict[str, Any]) -> str:
    canonical = json.dumps(args, sort_keys=True, default=str)
    digest = hashlib.sha256((kind + "|" + tool_name + "|" + canonical).encode("utf-8")).hexdigest()
    return tool_name + "-" + digest[:16]


def _cache_read(key: str) -> tuple[bool, Any]:
    path = os.path.join(_CACHE_DIR, key + ".json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            entry = json.load(handle)
    except (OSError, ValueError):
        return False, None
    fetched_at = entry.get("fetched_at")
    if not isinstance(fetched_at, (int, float)):
        return False, None
    if time.time() - fetched_at > _CACHE_TTL_SECONDS:
        return False, None
    return True, entry.get("data")


def _cache_write(key: str, data: Any) -> None:
    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
        path = os.path.join(_CACHE_DIR, key + ".json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump({"fetched_at": time.time(), "data": data}, handle, default=str)
        os.replace(tmp, path)
    except OSError:
        # A cache write failure must never break a query.
        pass


class TraceflowClient:
    def __init__(self, base_url: str | None = None, timeout: float = 120.0) -> None:
        self.base_url = (base_url or _resolve_base_url()).rstrip("/")
        self.timeout = timeout

    def _post(self, tool_name: str, args: dict[str, Any]) -> Any:
        url = self.base_url + "/tools/" + tool_name
        body = json.dumps(args).encode("utf-8")
        request = urllib.request.Request(
            url, data=body, headers={"content-type": "application/json"}, method="POST"
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            raise RuntimeError("Trace Flow tool " + tool_name + " failed: " + detail) from error
        return json.loads(payload) if payload else None

    def _call_raw(self, tool_name: str, args: dict[str, Any], refresh: bool = False) -> Any:
        key = _cache_key("raw", tool_name, args)
        if not refresh:
            hit, cached = _cache_read(key)
            if hit:
                return cached
        result = self._post(tool_name, args)
        _cache_write(key, result)
        return result

    def _call_df(self, tool_name: str, args: dict[str, Any], refresh: bool = False) -> pd.DataFrame:
        # Cache the assembled multi-page row list (the expensive part) keyed by the
        # caller's args; cursor is an internal paging detail and excluded from the key.
        key = _cache_key("df", tool_name, args)
        rows: list[Any] | None = None
        if not refresh:
            hit, cached = _cache_read(key)
            if hit and isinstance(cached, list):
                rows = cached
        if rows is None:
            rows = []
            page_args = dict(args)
            for _ in range(_MAX_PAGES):
                result = self._post(tool_name, page_args)
                rows.extend(_extract_rows(result))
                cursor = _next_cursor(result)
                if not cursor:
                    break
                page_args["cursor"] = cursor
            _cache_write(key, rows)
        return pd.json_normalize(rows) if rows else pd.DataFrame()


def _extract_rows(result: Any) -> list[Any]:
    if isinstance(result, list):
        return result
    if isinstance(result, dict):
        for key in ("data", "rows", "results", "items", "traces", "spans", "events"):
            value = result.get(key)
            if isinstance(value, list):
                return value
        # A single object (e.g. a summary row) is one row.
        return [result]
    return []


def _next_cursor(result: Any) -> str | None:
    if not isinstance(result, dict):
        return None
    pagination = result.get("pagination")
    if isinstance(pagination, dict):
        if pagination.get("has_more") and pagination.get("next_cursor"):
            return str(pagination["next_cursor"])
        return None
    cursor = result.get("next_cursor") or result.get("nextCursor")
    return str(cursor) if cursor else None

`;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = /^(.*?[.!?])(\s|$)/.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}

/** A scannable menu of every method with one-line guidance, so the agent can pick the right tool fast. */
function methodIndex(entries: { name: string; description: string }[]): string {
  if (entries.length === 0) return '';
  const lines = [
    "# Available methods (read each method's docstring for full guidance on when to use it).",
    '# Each <name> returns a DataFrame; <name>_raw returns decoded JSON for summary/object results.',
  ];
  for (const entry of entries) {
    for (const part of wrap(`tf.${entry.name}: ${firstSentence(entry.description)}`, '#   ')) {
      lines.push(part);
    }
  }
  return lines.join('\n');
}

export function buildTraceflowPythonClient(toolDefinitions: unknown[]): string {
  const definitions = Array.isArray(toolDefinitions)
    ? toolDefinitions.filter((d): d is ToolDefinitionLike => !!d && typeof d === 'object')
    : [];

  const models: string[] = [];
  const methods: string[] = [];
  const index: { name: string; description: string }[] = [];

  for (const definition of definitions) {
    const name = toolName(definition);
    if (!name || !isValidIdentifier(name)) continue;
    const schema = inputSchema(definition);
    const params = toolParams(schema);
    const description =
      typeof definition.description === 'string' ? definition.description : `Call ${name}`;
    models.push(pydanticModel(name, params));
    methods.push(methodSource(name, description, params));
    index.push({ name, description });
  }

  const classBody = methods.length ? methods.join('\n') : '    pass\n';

  return [
    runtimeBase(),
    methodIndex(index),
    '',
    '',
    models.join('\n\n'),
    '',
    '',
    'class TraceflowData(TraceflowClient):',
    classBody,
    '',
    'tf = TraceflowData()',
    '',
  ].join('\n');
}
