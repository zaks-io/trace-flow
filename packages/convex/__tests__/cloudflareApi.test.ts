import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudflareKvValuesUrl } from '../integrations/cloudflareApi';

describe('cloudflareKvValuesUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("targets Cloudflare's API by default", () => {
    vi.stubEnv('CLOUDFLARE_API_BASE_URL', undefined);
    expect(cloudflareKvValuesUrl('acc_123', 'ns_456')).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc_123/storage/kv/namespaces/ns_456/values',
    );
  });

  it('targets the configured API base URL', () => {
    vi.stubEnv('CLOUDFLARE_API_BASE_URL', 'http://host.docker.internal:8791');
    expect(cloudflareKvValuesUrl('local', 'ns_456')).toBe(
      'http://host.docker.internal:8791/accounts/local/storage/kv/namespaces/ns_456/values',
    );
  });
});
