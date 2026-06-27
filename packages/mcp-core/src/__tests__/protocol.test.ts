import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  SESSION_TTL_MS,
  JsonRpcErrorCode,
  MCP_SERVER_INFO,
  MCP_SERVER_CAPABILITIES,
  isInitializeParams,
} from '../protocol';

describe('SUPPORTED_PROTOCOL_VERSIONS', () => {
  it('contains at least one version', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS.length).toBeGreaterThan(0);
  });

  it('contains date-formatted version strings', () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('includes the latest MCP protocol version', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-11-25');
  });

  it('includes older protocol version for compatibility', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-06-18');
  });

  it('includes Codex startup protocol version for compatibility', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2024-11-05');
  });
});

describe('LATEST_PROTOCOL_VERSION', () => {
  it('equals the first supported version', () => {
    expect(LATEST_PROTOCOL_VERSION).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  });

  it('is a valid date string', () => {
    expect(LATEST_PROTOCOL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('SESSION_TTL_MS', () => {
  it('equals 24 hours in milliseconds', () => {
    expect(SESSION_TTL_MS).toBe(86400000);
  });
});

describe('JsonRpcErrorCode', () => {
  it('has ParseError code -32700', () => {
    expect(JsonRpcErrorCode.ParseError).toBe(-32700);
  });

  it('has InvalidRequest code -32600', () => {
    expect(JsonRpcErrorCode.InvalidRequest).toBe(-32600);
  });

  it('has MethodNotFound code -32601', () => {
    expect(JsonRpcErrorCode.MethodNotFound).toBe(-32601);
  });

  it('has InvalidParams code -32602', () => {
    expect(JsonRpcErrorCode.InvalidParams).toBe(-32602);
  });

  it('has InternalError code -32603', () => {
    expect(JsonRpcErrorCode.InternalError).toBe(-32603);
  });

  it('contains all standard JSON-RPC error codes', () => {
    const codes = Object.values(JsonRpcErrorCode);
    expect(codes).toContain(-32700);
    expect(codes).toContain(-32600);
    expect(codes).toContain(-32601);
    expect(codes).toContain(-32602);
    expect(codes).toContain(-32603);
  });
});

describe('MCP_SERVER_INFO', () => {
  it('has a name property', () => {
    expect(MCP_SERVER_INFO.name).toBeDefined();
    expect(typeof MCP_SERVER_INFO.name).toBe('string');
  });

  it('has name set to trace-flow-mcp', () => {
    expect(MCP_SERVER_INFO.name).toBe('trace-flow-mcp');
  });

  it('has a version property', () => {
    expect(MCP_SERVER_INFO.version).toBeDefined();
    expect(typeof MCP_SERVER_INFO.version).toBe('string');
  });

  it('has a valid semver version', () => {
    expect(MCP_SERVER_INFO.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('MCP_SERVER_CAPABILITIES', () => {
  it('has tools capability', () => {
    expect(MCP_SERVER_CAPABILITIES.tools).toBeDefined();
  });

  it('has tools.listChanged set to false', () => {
    expect(MCP_SERVER_CAPABILITIES.tools.listChanged).toBe(false);
  });

  it('does not advertise resources capability', () => {
    expect('resources' in MCP_SERVER_CAPABILITIES).toBe(false);
  });

  it('does not advertise prompts capability', () => {
    expect('prompts' in MCP_SERVER_CAPABILITIES).toBe(false);
  });
});

describe('isInitializeParams', () => {
  const validParams = {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'client', version: '1.0.0' },
  };

  it('accepts valid initialize params', () => {
    expect(isInitializeParams(validParams)).toBe(true);
  });

  it('rejects array capabilities', () => {
    expect(isInitializeParams({ ...validParams, capabilities: [] })).toBe(false);
  });

  it('rejects array clientInfo', () => {
    expect(isInitializeParams({ ...validParams, clientInfo: [] })).toBe(false);
  });
});
