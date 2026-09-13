import { startTinybirdQuerySpan, recordTinybirdResponse, finishTinybirdQuerySpan } from './tracing';

export interface DeleteRowsOptions {
  baseUrl: string;
  token: string;
  datasource: string;
  condition: string;
}

/** The Delete API returns a job receipt, not proof that matching rows have been removed. */
export async function startDeleteRows(options: DeleteRowsOptions): Promise<string> {
  if (!/^[a-zA-Z0-9_]+$/.test(options.datasource)) throw new Error('Invalid delete datasource');
  const span = startTinybirdQuerySpan({ baseUrl: options.baseUrl });
  span.setAttribute('db.operation.name', 'delete');
  span.setAttribute('db.collection.name', options.datasource);
  let succeeded = false;
  try {
    const response = await fetch(
      new URL(`/v0/datasources/${options.datasource}/delete`, options.baseUrl),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ delete_condition: options.condition }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    recordTinybirdResponse(span, response);
    if (!response.ok) throw new Error(`Tinybird row deletion failed: HTTP ${response.status}`);
    const body: { job_id?: unknown } = await response.json();
    if (typeof body.job_id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(body.job_id)) {
      throw new Error('Tinybird deletion returned no valid job receipt');
    }
    succeeded = true;
    return body.job_id;
  } finally {
    finishTinybirdQuerySpan(span, succeeded);
  }
}

export async function waitForDeleteRows(
  options: Pick<DeleteRowsOptions, 'baseUrl' | 'token'>,
  jobId: string,
  deadlineMs: number,
): Promise<void> {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(jobId)) throw new Error('Invalid Tinybird deletion job');
  while (Date.now() < deadlineMs) {
    const response = await fetch(new URL(`/v0/jobs/${jobId}`, options.baseUrl), {
      headers: { Authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Tinybird deletion status failed: HTTP ${response.status}`);
    const body: { job_id?: unknown; status?: unknown } = await response.json();
    if (body.job_id !== jobId) throw new Error('Tinybird deletion job identity mismatch');
    if (body.status === 'done') return;
    if (!['waiting', 'working'].includes(String(body.status)))
      throw new Error('Tinybird deletion job failed');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('Tinybird deletion has not completed before its deadline');
}
