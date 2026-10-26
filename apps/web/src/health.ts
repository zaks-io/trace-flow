export function healthResponse(request: Request): Response {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify({ status: 'ok' }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
