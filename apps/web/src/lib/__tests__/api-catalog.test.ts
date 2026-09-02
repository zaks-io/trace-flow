import { describe, expect, it } from 'vitest';
import { buildApiCatalog } from '../api-catalog';

describe('buildApiCatalog', () => {
  it('anchors every entry at an absolute https API endpoint', () => {
    const { linkset } = buildApiCatalog('https://trace-flow.dev');

    expect(linkset.length).toBeGreaterThan(0);
    for (const entry of linkset) {
      expect(entry.anchor).toMatch(/^https:\/\//);
    }
  });

  it('gives every entry human docs and a machine-readable health target', () => {
    const { linkset } = buildApiCatalog('https://trace-flow.dev');

    for (const entry of linkset) {
      expect(entry['service-doc']?.[0]?.href).toMatch(/^https:\/\/trace-flow\.dev\/docs\//);
      expect(entry.status?.[0]?.href).toMatch(/\/healthz$/);
    }
  });

  it('describes the gateway with its OpenAPI document', () => {
    const gateway = buildApiCatalog('https://trace-flow.dev').linkset.find(
      (entry) => entry.anchor === 'https://gateway.trace-flow.dev',
    );

    expect(gateway?.['service-desc']).toEqual([
      expect.objectContaining({ href: 'https://gateway.trace-flow.dev/openapi.json' }),
    ]);
  });

  it('points documentation at the deploy serving the catalog', () => {
    const { linkset } = buildApiCatalog('https://trace-flow-web-preview.example.workers.dev/');

    for (const entry of linkset) {
      expect(entry['service-doc']?.[0]?.href).toMatch(
        /^https:\/\/trace-flow-web-preview\.example\.workers\.dev\/docs\//,
      );
    }
  });
});
