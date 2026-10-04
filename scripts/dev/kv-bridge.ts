/**
 * Stand-in for Cloudflare's KV REST API in the disposable local stack (local-stack.sh).
 *
 * Convex syncs API keys, subscriptions, Collector Credentials and model pricing to
 * Workers KV over Cloudflare's API. Local Workers read miniflare KV instead, so the
 * local Convex backend sends those writes here (CLOUDFLARE_API_BASE_URL). This Worker
 * binds each namespace as `KV_<namespace id>` and shares the Workers' persisted state.
 *
 * It implements only the value reads, writes and deletes Convex makes.
 */
interface KvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

type Env = { KV_BRIDGE_TOKEN: string } & Record<string, unknown>;

const VALUE_PATH = /^\/accounts\/[^/]+\/storage\/kv\/namespaces\/([^/]+)\/values\/(.+)$/;

function apiResponse(status: number, message?: string): Response {
  const errors = message ? [{ code: status, message }] : [];
  return Response.json({ success: status < 400, errors, messages: [], result: null }, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('Authorization') !== `Bearer ${env.KV_BRIDGE_TOKEN}`) {
      return apiResponse(401, 'Authentication error');
    }
    const match = VALUE_PATH.exec(new URL(request.url).pathname);
    const kv = match ? (env[`KV_${match[1]}`] as KvNamespace | undefined) : undefined;
    if (!match || !kv) return apiResponse(404, 'Unknown namespace or route');
    const key = decodeURIComponent(match[2]);

    switch (request.method) {
      case 'GET': {
        const value = await kv.get(key);
        return value === null ? apiResponse(404, 'key not found') : new Response(value);
      }
      case 'PUT':
        await kv.put(key, await request.text());
        return apiResponse(200);
      case 'DELETE':
        await kv.delete(key);
        return apiResponse(200);
      default:
        return apiResponse(405, 'Method not allowed');
    }
  },
};
