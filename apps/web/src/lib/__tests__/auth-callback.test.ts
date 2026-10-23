import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import { AuthorizationError, InvalidStateError, OAuth2Error } from '@auth0/nextjs-auth0/errors';
import { handleAuthCallback } from '../auth-callback';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const signupRefused = new AuthorizationError({
  cause: new OAuth2Error({ code: 'invalid_request', message: 'signup is disabled' }),
});

describe('handleAuthCallback', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('sends a refused sign-up to the auth error page and reports it', async () => {
    const response = await handleAuthCallback(
      signupRefused,
      { appBaseUrl: 'https://trace-flow.dev', returnTo: '/app' },
      null,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://trace-flow.dev/auth/error');
    expect(Sentry.captureException).toHaveBeenCalledWith(signupRefused);
  });

  it('falls back to APP_BASE_URL when the SDK could not resolve one', async () => {
    vi.stubEnv('APP_BASE_URL', 'https://trace-flow.dev');

    const response = await handleAuthCallback(new InvalidStateError(), {}, null);

    expect(response.headers.get('location')).toBe('https://trace-flow.dev/auth/error');
  });

  it('rethrows the callback error when no base URL is available', async () => {
    vi.stubEnv('APP_BASE_URL', '');
    const error = new InvalidStateError();

    await expect(handleAuthCallback(error, {}, null)).rejects.toBe(error);
  });

  it('continues a successful sign-in to its return path', async () => {
    const response = await handleAuthCallback(
      null,
      { appBaseUrl: 'https://trace-flow.dev', returnTo: '/app/traces?range=7d' },
      null,
    );

    expect(response.headers.get('location')).toBe('https://trace-flow.dev/app/traces?range=7d');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('keeps a protocol-relative return path on the app origin', async () => {
    const response = await handleAuthCallback(
      null,
      { appBaseUrl: 'https://trace-flow.dev', returnTo: '//evil.example/phish' },
      null,
    );

    expect(response.headers.get('location')).toBe('https://trace-flow.dev/');
  });
});
