export enum ProviderAuthType {
  X_API_KEY = 'x-api-key',
  BEARER = 'bearer',
}

export interface ProviderConfig {
  authType: ProviderAuthType;
}

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  'api.anthropic.com': {
    authType: ProviderAuthType.X_API_KEY,
  },
  'api.openai.com': {
    authType: ProviderAuthType.BEARER,
  },
  'openrouter.ai': {
    authType: ProviderAuthType.BEARER,
  },
};

export function detectProvider(targetUrl: string): ProviderConfig {
  try {
    const url = new URL(targetUrl);
    const hostname = url.hostname;

    return (
      PROVIDER_CONFIGS[hostname] ?? {
        authType: ProviderAuthType.BEARER,
      }
    );
  } catch {
    return {
      authType: ProviderAuthType.BEARER,
    };
  }
}

export function injectProviderAuth(
  headers: Headers,
  providerApiKey: string,
  targetUrl: string,
): void {
  const config = detectProvider(targetUrl);

  if (config.authType === ProviderAuthType.X_API_KEY) {
    headers.set('x-api-key', providerApiKey);
  } else {
    headers.set('Authorization', `Bearer ${providerApiKey}`);
  }
}
