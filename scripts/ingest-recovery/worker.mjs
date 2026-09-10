const AGENT_METHODS = new Set(['beginFactRebuild', 'listRebuildFacts', 'completeFactRebuild']);
const READ_METHODS = new Set(['listRecovery', 'listRebuildFacts']);
const METHODS = new Set(['listRecovery', 'reconcileRecovery', 'replayDlq', ...AGENT_METHODS]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      return new Response('Recovery is available through the local operator tool', { status: 403 });
    }
    if (request.headers.has('Origin'))
      return new Response('Browser requests are forbidden', { status: 403 });
    if (request.method !== 'POST' || request.headers.get('Content-Type') !== 'application/json') {
      return new Response('Send a JSON POST', { status: 400 });
    }
    const method = url.pathname.slice(1);
    if (!METHODS.has(method)) return new Response('Unknown recovery method', { status: 404 });
    let input;
    try {
      input = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }
    if (
      !input ||
      !['proxy', 'agent'].includes(input.pipeline) ||
      typeof input.shardId !== 'string'
    ) {
      return new Response('pipeline and shardId are required', { status: 400 });
    }
    if (AGENT_METHODS.has(method) && input.pipeline !== 'agent') {
      return new Response('Fact rebuild requires the agent pipeline', { status: 400 });
    }
    if (!READ_METHODS.has(method) && input.confirm !== 'apply-recovery') {
      return new Response('Explicit apply-recovery confirmation is required', { status: 400 });
    }
    const service = input.pipeline === 'proxy' ? env.PROXY_RECOVERY : env.AGENT_RECOVERY;
    try {
      const result = await service[method](input.shardId, input.options);
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
      return new Response('Recovery failed; inspect the consumer logs', { status: 502 });
    }
  },
};
