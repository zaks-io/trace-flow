const archiveStatusFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).pathname === '/archive-api/status') {
    const body = await request.json();
    const revision =
      typeof body === 'object' && body !== null && 'revision' in body ? body.revision : undefined;
    return Response.json({ revision, replay: false });
  }
  return archiveStatusFetch(input, init);
};
