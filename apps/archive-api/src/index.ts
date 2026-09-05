/**
 * Archive API Worker. Owns the archive.trace-flow.dev authorization boundary:
 * Collector Credential + current enrollment for uploads, and a fail-closed
 * Archive Export Grant placeholder for reads and deletion. Upload persistence
 * is serialized by the Archive Session Ledger Durable Object.
 */
import * as Sentry from '@sentry/cloudflare';
import { Hono } from 'hono';
import type { ArchiveApiEnv } from './context';
import { createArchiveApiSentryOptions } from './sentry';
import {
  handleDeleteArchive,
  handleDeleteContribution,
  handleExport,
  handleHealthz,
  handleRotateKey,
  handleRotationHealth,
  handleUpload,
} from './handler';
export { ArchiveSessionLedger } from './archive-ledger';
export { StorageBudget } from './archive-storage-budget';

export const app = new Hono<{ Bindings: ArchiveApiEnv }>();

app.get('/healthz', handleHealthz);

app.post('/v1/archive/uploads', handleUpload);

app.get('/v1/archive/exports', handleExport);
app.post('/v1/archive/exports', handleExport);

app.delete('/v1/archive/contributions/:contributionId', handleDeleteContribution);
app.delete('/v1/archive', handleDeleteArchive);

app.post('/v1/archive/key-rotations', handleRotateKey);
app.get('/v1/archive/key-rotations/:orgId', handleRotationHealth);

export default Sentry.withSentry(createArchiveApiSentryOptions, app);
