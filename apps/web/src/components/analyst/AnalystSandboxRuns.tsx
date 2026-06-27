'use client';

import { useMemo } from 'react';
import { useQuery } from 'convex/react';
import type { Id } from '@convex/_generated/dataModel';
import { api } from '@convex/_generated/api';
import { buildFallbackRun, type PiAgentStartOutput, type SandboxRun } from './piRunEvents';
import { PiRunCard } from './piRun/PiRunCard';

export type { PiAgentStartOutput, SandboxRun } from './piRunEvents';

/**
 * A single analysis run rendered inline as part of the parent agent's turn, with a
 * fallback shell before Convex hydrates. Carries no card chrome of its own.
 */
export function AnalystSandboxRunInline({
  runId,
  output,
  toolState,
}: {
  runId: string;
  output: PiAgentStartOutput;
  toolState: string;
}) {
  const convexRunId = runId as Id<'analystSandboxRuns'>;
  const run = useQuery(api.analyst.getSandboxRun, { runId: convexRunId }) as
    | SandboxRun
    | null
    | undefined;
  const fallbackRun = useMemo(() => buildFallbackRun(convexRunId, output), [convexRunId, output]);

  return <PiRunCard run={run ?? fallbackRun} toolState={toolState} resumed={output.resumed} />;
}
