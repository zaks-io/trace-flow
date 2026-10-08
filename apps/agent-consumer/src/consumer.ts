import type { AgentIngestQueueMessage } from '@trace-flow/types';
import type { Accumulator } from './facts';
import { type PriceCache, priceMessage } from './pricing';
import {
  batchContext,
  capabilitySnapshotRow,
  fileEventRow,
  messageRow,
  pullRequestLinkRow,
  reviewUnitAttributionRow,
  toolEventRow,
} from './rows';

/** Maps one well-formed message's facts into the row accumulator, pricing each Agent Message. */
export async function accumulateMessage(
  body: AgentIngestQueueMessage,
  acc: Accumulator,
  cache: PriceCache,
): Promise<void> {
  const ctx = batchContext(body);

  for (const fact of body.facts.messages) {
    const cost = await priceMessage(fact, body.source, cache);
    acc.messages.push(messageRow(ctx, fact, cost));
  }
  for (const fact of body.facts.tool_events) {
    acc.tool_events.push(toolEventRow(ctx, fact));
  }
  for (const fact of body.facts.file_events) {
    acc.file_events.push(fileEventRow(ctx, fact));
  }
  for (const fact of body.facts.capability_snapshots) {
    acc.capability_snapshots.push(capabilitySnapshotRow(ctx, fact));
  }
  for (const fact of body.facts.pull_request_links) {
    acc.pull_request_links.push(pullRequestLinkRow(ctx, fact));
  }
  for (const fact of body.facts.review_unit_attributions ?? []) {
    acc.review_unit_attributions.push(reviewUnitAttributionRow(ctx, fact));
  }
}
