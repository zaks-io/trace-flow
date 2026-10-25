import type { HonoWithConvex } from 'convex-helpers/server/hono';
import { BodySizeLimitError } from '@trace-flow/utils';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { isValidCodeVerifier } from './mcpPkce';
import { readBoundedText } from './requestBody';
import { getRequestLogger } from './shared';

const TOKEN_REQUEST_MAX_BYTES = 4 * 1024;

export function registerCollectorTokenRoutes(app: HonoWithConvex<ActionCtx>): void {
  // Collector CLI login, second leg: redeem the one-time code from the sign-in redirect with the
  // PKCE verifier only the CLI holds. The new Collector Credential travels in this response body,
  // never in a URL.
  app.post('/collector/token', async (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    const ctx = c.env;
    const logger = getRequestLogger(c.req.raw, { operation: 'collector_token' });
    const reject = async (status: 400 | 403 | 413 | 415, error: string, description: string) => {
      logger.warn('convex.collector_token_rejected', { status, reason: description });
      await logger.flush();
      return c.json({ error, error_description: description }, status);
    };

    try {
      const mediaType = c.req.header('Content-Type')?.toLowerCase().split(';', 1)[0]?.trim();
      if (mediaType !== 'application/x-www-form-urlencoded') {
        return await reject(
          415,
          'invalid_request',
          'Content-Type must be application/x-www-form-urlencoded',
        );
      }

      const body = new URLSearchParams(await readBoundedText(c.req.raw, TOKEN_REQUEST_MAX_BYTES));
      const code = body.get('code');
      const codeVerifier = body.get('code_verifier');
      if (!code) {
        return await reject(400, 'invalid_request', 'code is required');
      }
      if (!codeVerifier || !isValidCodeVerifier(codeVerifier)) {
        return await reject(400, 'invalid_request', 'code_verifier must be a valid PKCE verifier');
      }

      const collectorId = `cli-${crypto.randomUUID()}`;
      let redeemed;
      try {
        redeemed = await ctx.runMutation(internal.collectorLogin.redeemLoginCode, {
          code,
          codeVerifier,
          collectorId,
        });
      } catch (error) {
        if (String(error).includes('User account is not enabled')) {
          return await reject(403, 'access_denied', 'User account is not enabled');
        }
        throw error;
      }
      if ('error' in redeemed) {
        return await reject(400, 'invalid_grant', redeemed.error);
      }

      logger.info('convex.collector_login_minted', { org_id: redeemed.orgId });
      await logger.flush();
      return c.json({
        secret: redeemed.secret,
        org_id: redeemed.orgId,
        collector_id: collectorId,
        convex_url: new URL(c.req.url).origin,
      });
    } catch (err) {
      if (err instanceof BodySizeLimitError) {
        return await reject(413, 'invalid_request', 'Request body is too large');
      }
      logger.error('convex.collector_token_failed', err);
      await logger.flush();
      return c.json({ error: 'server_error', error_description: 'Sign-in failed' }, 500);
    }
  });
}
