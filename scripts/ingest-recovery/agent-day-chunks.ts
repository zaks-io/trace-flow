import { MAX_AGENT_ANALYTICS_DAY_BUCKETS } from '../../packages/utils/src/agent-retention';
import { MAX_AGENT_SNAPSHOT_COPY_DAYS } from '../../apps/agent-consumer/src/agent-delivery-coordinator-contract';

export interface AgentDayRange {
  startDay: string;
  endDay: string;
}

export interface AgentDayChunk extends AgentDayRange {
  days: string[];
}

export function chunkAgentDayRange(range: AgentDayRange): AgentDayChunk[] {
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(range.startDay) || !pattern.test(range.endDay)) {
    throw new Error('Agent day range dates must use YYYY-MM-DD');
  }
  const start = Date.parse(`${range.startDay}T00:00:00.000Z`);
  const end = Date.parse(`${range.endDay}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error('Agent day range is invalid');
  }
  const count = Math.floor((end - start) / 86_400_000) + 1;
  if (count > MAX_AGENT_ANALYTICS_DAY_BUCKETS) {
    throw new Error('Agent day range exceeds retained history');
  }
  const days = Array.from({ length: count }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10),
  );
  const chunks: AgentDayChunk[] = [];
  for (let offset = 0; offset < days.length; offset += MAX_AGENT_SNAPSHOT_COPY_DAYS) {
    const chunk = days.slice(offset, offset + MAX_AGENT_SNAPSHOT_COPY_DAYS);
    chunks.push({ startDay: chunk[0]!, endDay: chunk.at(-1)!, days: chunk });
  }
  return chunks;
}
