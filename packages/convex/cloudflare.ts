import { internalAction } from './_generated/server';
import { v } from 'convex/values';

export const syncKeyToKV = internalAction({
  args: {
    key: v.string(),
    expiresAt: v.number(),
  },
  handler: async (_ctx, args) => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const namespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID;

    if (!accountId) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID environment variable is not set');
    }

    if (!apiToken) {
      throw new Error('CLOUDFLARE_API_TOKEN environment variable is not set');
    }

    if (!namespaceId) {
      throw new Error('CLOUDFLARE_KV_NAMESPACE_ID environment variable is not set');
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${args.key}`;

    const value = JSON.stringify({
      expiresAt: args.expiresAt,
      createdAt: Date.now(),
    });

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'text/plain',
      },
      body: value,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to sync key to KV: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }
  },
});

export const checkKeyInKV = internalAction({
  args: {
    key: v.string(),
  },
  handler: async (_ctx, args): Promise<boolean> => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const namespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID;

    if (!accountId || !apiToken || !namespaceId) {
      throw new Error('Cloudflare environment variables not set');
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${args.key}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
    });

    return response.ok;
  },
});

export const deleteKeyFromKV = internalAction({
  args: {
    key: v.string(),
  },
  handler: async (_ctx, args) => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const namespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID;

    if (!accountId) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID environment variable is not set');
    }

    if (!apiToken) {
      throw new Error('CLOUDFLARE_API_TOKEN environment variable is not set');
    }

    if (!namespaceId) {
      throw new Error('CLOUDFLARE_KV_NAMESPACE_ID environment variable is not set');
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${args.key}`;

    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to delete key from KV: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }
  },
});
