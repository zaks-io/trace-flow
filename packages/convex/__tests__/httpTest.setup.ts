import { vi, type Mock } from 'vitest';
import type { HttpDeps } from '../http';

export interface MockCtx {
  runMutation: Mock;
  runQuery: Mock;
  runAction: Mock;
}

export function createMockCtx(): MockCtx {
  return {
    runMutation: vi.fn(),
    runQuery: vi.fn(),
    runAction: vi.fn(),
  };
}

export function captureConsoleLogs(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const collect = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(collect),
    vi.spyOn(console, 'info').mockImplementation(collect),
    vi.spyOn(console, 'warn').mockImplementation(collect),
    vi.spyOn(console, 'error').mockImplementation(collect),
    vi.spyOn(console, 'debug').mockImplementation(collect),
  ];
  return {
    text: () => lines.join('\n'),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

export function createMockDeps(): HttpDeps {
  return {
    oauth: {
      signState: vi.fn(),
      verifyState: vi.fn(),
      signConsent: vi.fn(),
      verifyConsent: vi.fn(),
      buildAuth0AuthorizeUrl: vi.fn(),
      exchangeAuth0Code: vi.fn(),
      getAuth0UserInfo: vi.fn(),
      refreshAuth0Token: vi.fn(),
    },
    tokens: {
      createAccessToken: vi.fn(),
      validateAccessToken: vi.fn(),
      ACCESS_TOKEN_TTL_SECONDS: 3600,
    } as unknown as HttpDeps['tokens'],
  };
}

export const acceptedConsent = {
  tokenUse: 'mcp_consent' as const,
  clientState: 'client-state',
  clientId: 'client-1',
  redirectUri: 'https://example.com/callback',
  resource: 'https://mcp.example.com/mcp',
  codeChallenge: 'challenge123',
  codeChallengeMethod: 'S256',
  responseType: 'code',
};
