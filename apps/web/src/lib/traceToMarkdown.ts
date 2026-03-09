import { isLLMRequestSpan, parseSpanAttributes, type TraceSpan } from './spans';
import { calculateCacheHitRate, calculateUncachedInputTokens } from './cacheMetrics';

interface TokenSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheHitRate: number | null;
  wallClockDuration: number;
  llmActiveDuration: number;
  idleTime: number;
  totalCost: number;
  llmCallCount: number;
}

interface LLMCall {
  index: number;
  spanId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  newTokens: number;
  cost: number | null;
  duration: number;
  status: string;
  startOffset: number;
  endOffset: number;
}

function aggregateTokens(spans: TraceSpan[]): TokenSummary {
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let totalCost = 0;
  let minTimestamp = Infinity;
  let maxEndTimestamp = 0;
  let llmCallCount = 0;
  let llmActiveDuration = 0;

  for (const span of spans) {
    const attrs = parseSpanAttributes(span.SpanAttributes);

    if (isLLMRequestSpan(span)) {
      llmCallCount++;
      llmActiveDuration += span.Duration;
    }

    const prompt = parseInt(attrs['gen_ai.usage.input_tokens'] ?? '0', 10);
    const completion = parseInt(attrs['gen_ai.usage.output_tokens'] ?? '0', 10);
    const cacheRead = parseInt(attrs['gen_ai.usage.cache_read_input_tokens'] ?? '0', 10);
    const cacheCreation = parseInt(attrs['gen_ai.usage.cache_creation_input_tokens'] ?? '0', 10);

    promptTokens += prompt;
    completionTokens += completion;
    cacheReadTokens += cacheRead;
    cacheCreationTokens += cacheCreation;

    if (attrs['gen_ai.cost.total']) {
      totalCost += parseFloat(attrs['gen_ai.cost.total']);
    }

    minTimestamp = Math.min(minTimestamp, span.Timestamp);
    maxEndTimestamp = Math.max(maxEndTimestamp, span.Timestamp + span.Duration);
  }

  const wallClockDuration = spans.length > 0 ? maxEndTimestamp - minTimestamp : 0;
  const idleTime = Math.max(0, wallClockDuration - llmActiveDuration);
  const cacheHitRate = calculateCacheHitRate(cacheReadTokens, cacheCreationTokens, promptTokens);

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheHitRate,
    wallClockDuration,
    llmActiveDuration,
    idleTime,
    totalCost,
    llmCallCount,
  };
}

function extractLLMCalls(spans: TraceSpan[], traceStart: number): LLMCall[] {
  const llmSpans = spans.filter(isLLMRequestSpan);
  return llmSpans.map((span, index) => {
    const attrs = parseSpanAttributes(span.SpanAttributes);

    const promptTokens = parseInt(attrs['gen_ai.usage.input_tokens'] ?? '0', 10);
    const completionTokens = parseInt(attrs['gen_ai.usage.output_tokens'] ?? '0', 10);
    const cacheReadTokens = parseInt(attrs['gen_ai.usage.cache_read_input_tokens'] ?? '0', 10);
    const cacheCreationTokens = parseInt(
      attrs['gen_ai.usage.cache_creation_input_tokens'] ?? '0',
      10,
    );

    const cost = attrs['gen_ai.cost.total'] ? parseFloat(attrs['gen_ai.cost.total']) : null;

    return {
      index: index + 1,
      spanId: span.SpanId,
      provider: attrs['gen_ai.system'] ?? 'unknown',
      model: (() => {
        const raw = attrs['gen_ai.request.model'] ?? 'unknown';
        const prov = attrs['gen_ai.system'];
        if (!prov) return raw;
        const name = raw.includes('/') ? raw.split('/').slice(1).join('/') : raw;
        return `${prov}/${name}`;
      })(),
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cacheReadTokens,
      cacheCreationTokens,
      newTokens: calculateUncachedInputTokens(
        promptTokens,
        cacheReadTokens,
        cacheCreationTokens,
        attrs['gen_ai.usage.input_tokens_uncached']
          ? parseInt(attrs['gen_ai.usage.input_tokens_uncached'], 10)
          : undefined,
      ),
      cost,
      duration: span.Duration,
      status: span.StatusCode,
      startOffset: span.Timestamp - traceStart,
      endOffset: span.Timestamp + span.Duration - traceStart,
    };
  });
}

function formatDuration(nanoseconds: number): string {
  const ms = nanoseconds / 1_000_000;
  if (ms < 1000) {
    return `${ms.toFixed(0)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatOffset(nanoseconds: number): string {
  const ms = nanoseconds / 1_000_000;
  if (ms < 1000) {
    return `+${ms.toFixed(0)}ms`;
  }
  return `+${(ms / 1000).toFixed(2)}s`;
}

function formatCost(dollars: number): string {
  if (dollars < 0.01) {
    return `$${dollars.toFixed(4)}`;
  }
  if (dollars < 1) {
    return `$${dollars.toFixed(3)}`;
  }
  return `$${dollars.toFixed(2)}`;
}

function formatNumber(num: number): string {
  return new Intl.NumberFormat().format(num);
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(0)}%`;
}

interface GapInfo {
  duration: number;
  afterCallIndex: number;
  beforeCallIndex: number;
}

function findGaps(llmCalls: LLMCall[]): GapInfo[] {
  if (llmCalls.length < 2) return [];

  const sortedCalls = [...llmCalls].sort((a, b) => a.startOffset - b.startOffset);
  const gaps: GapInfo[] = [];

  for (let i = 0; i < sortedCalls.length - 1; i++) {
    const current = sortedCalls[i];
    const next = sortedCalls[i + 1];
    const gapDuration = next.startOffset - current.endOffset;

    if (gapDuration > 0) {
      gaps.push({
        duration: gapDuration,
        afterCallIndex: current.index,
        beforeCallIndex: next.index,
      });
    }
  }

  return gaps;
}

function renderGanttChart(llmCalls: LLMCall[], totalDuration: number): string {
  if (llmCalls.length === 0 || totalDuration === 0) return '';

  const width = 50;
  const lines: string[] = [];

  lines.push('```');
  lines.push(`Timeline (${formatDuration(totalDuration)} wall clock):`);
  lines.push(`0${' '.repeat(width - 6)}${formatDuration(totalDuration)}`);
  lines.push(`|${'-'.repeat(width - 2)}|`);

  const sortedCalls = [...llmCalls].sort((a, b) => a.startOffset - b.startOffset);
  const gaps = findGaps(llmCalls);

  for (const call of sortedCalls) {
    // Render the call bar
    const startPos = Math.floor((call.startOffset / totalDuration) * (width - 2));
    const endPos = Math.floor((call.endOffset / totalDuration) * (width - 2));
    const barLength = Math.max(1, endPos - startPos);

    let bar = ' '.repeat(startPos) + '█'.repeat(barLength);
    bar = bar.padEnd(width - 2, ' ');

    const statusMark = call.status === 'ERROR' ? ' ERR' : '';
    const label = `#${call.index} ${call.model}${statusMark}`;
    lines.push(`|${bar}| ${label}`);

    // Check for gap after this call
    const gapAfter = gaps.find((g) => g.afterCallIndex === call.index);
    if (gapAfter && gapAfter.duration > totalDuration * 0.05) {
      lines.push(`|${' '.repeat(width - 2)}|   ↓ ${formatDuration(gapAfter.duration)} gap`);
    }
  }

  lines.push('```');

  // Show largest gap summary if significant
  if (gaps.length > 0) {
    const largestGap = gaps.reduce((a, b) => (a.duration > b.duration ? a : b));
    if (largestGap.duration > totalDuration * 0.1) {
      lines.push('');
      lines.push(
        `Largest gap: ${formatDuration(largestGap.duration)} between #${largestGap.afterCallIndex} and #${largestGap.beforeCallIndex}`,
      );
    }
  }

  return lines.join('\n');
}

interface SpanNode {
  span: TraceSpan;
  children: SpanNode[];
}

function buildSpanTree(spans: TraceSpan[]): SpanNode[] {
  const spanMap = new Map<string, SpanNode>();
  const roots: SpanNode[] = [];

  for (const span of spans) {
    spanMap.set(span.SpanId, { span, children: [] });
  }

  for (const span of spans) {
    const node = spanMap.get(span.SpanId)!;
    if (span.ParentSpanId === '' || !spanMap.has(span.ParentSpanId)) {
      roots.push(node);
    } else {
      const parent = spanMap.get(span.ParentSpanId);
      parent?.children.push(node);
    }
  }

  return roots;
}

function renderSpanTree(nodes: SpanNode[], traceStart: number, depth = 0): string {
  const lines: string[] = [];
  const indent = '  '.repeat(depth);

  for (const node of nodes) {
    const { span } = node;
    const attrs = parseSpanAttributes(span.SpanAttributes);
    const duration = formatDuration(span.Duration);
    const offset = formatOffset(span.Timestamp - traceStart);
    const statusIcon = span.StatusCode === 'ERROR' ? ' ERROR' : '';

    const tokens =
      parseInt(attrs['gen_ai.usage.input_tokens'] ?? '0', 10) +
      parseInt(attrs['gen_ai.usage.output_tokens'] ?? '0', 10);

    const parts: string[] = [`${indent}- **${span.SpanName}**${statusIcon}`];
    parts.push(`[${offset} → ${duration}]`);

    if (isLLMRequestSpan(span)) {
      const model = attrs['gen_ai.request.model'];
      if (model) parts.push(`model=${model}`);
    }

    if (tokens > 0) {
      parts.push(`${formatNumber(tokens)}t`);
    }

    const cost = attrs['gen_ai.cost.total'] ? parseFloat(attrs['gen_ai.cost.total']) : null;
    if (cost !== null && cost > 0) {
      parts.push(formatCost(cost));
    }

    lines.push(parts.join(' | '));

    if (node.children.length > 0) {
      lines.push(renderSpanTree(node.children, traceStart, depth + 1));
    }
  }

  return lines.join('\n');
}

export function estimateMarkdownTokens(spans: TraceSpan[]): number {
  const markdown = generateTraceMarkdown(spans);
  return Math.ceil(markdown.length / 4);
}

export function generateTraceMarkdown(spans: TraceSpan[]): string {
  if (spans.length === 0) {
    return '# Trace\n\nNo spans found.';
  }

  const traceId = spans[0].TraceId;
  const traceStart = Math.min(...spans.map((s) => s.Timestamp));
  const summary = aggregateTokens(spans);
  const llmCalls = extractLLMCalls(spans, traceStart);

  const lines: string[] = [];

  lines.push(`# Trace: ${traceId}`);
  lines.push('');

  // Summary section
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');

  // Duration breakdown
  lines.push(`| Wall Clock | ${formatDuration(summary.wallClockDuration)} |`);
  lines.push(`| LLM Active Time | ${formatDuration(summary.llmActiveDuration)} |`);
  if (summary.idleTime > 0) {
    const idlePercent =
      summary.wallClockDuration > 0
        ? formatPercent(summary.idleTime / summary.wallClockDuration)
        : '0%';
    lines.push(`| Idle Time | ${formatDuration(summary.idleTime)} (${idlePercent}) |`);
  }

  lines.push(`| LLM Calls | ${summary.llmCallCount} |`);
  lines.push(
    `| Input Tokens | ${summary.promptTokens > 0 ? formatNumber(summary.promptTokens) : '-'} |`,
  );
  lines.push(
    `| Output Tokens | ${summary.completionTokens > 0 ? formatNumber(summary.completionTokens) : '-'} |`,
  );

  // Cache info - show as cached/new ratio
  if (summary.cacheReadTokens > 0 || summary.cacheCreationTokens > 0) {
    const newTokens = Math.max(0, summary.promptTokens - summary.cacheReadTokens);
    lines.push(
      `| Cache | ${formatNumber(summary.cacheReadTokens)} cached / ${formatNumber(newTokens)} new |`,
    );
    if (summary.cacheCreationTokens > 0) {
      lines.push(`| Cache Created | ${formatNumber(summary.cacheCreationTokens)} |`);
    }

    // Add cache hit rate with emoji indicator
    if (summary.cacheHitRate !== null) {
      const hitRateEmoji =
        summary.cacheHitRate >= 80 ? '🟢' : summary.cacheHitRate >= 50 ? '🟡' : '🔴';
      lines.push(`| Cache Hit Rate | ${hitRateEmoji} ${summary.cacheHitRate.toFixed(1)}% |`);
    }
  }

  lines.push(`| Total Cost | ${summary.totalCost > 0 ? formatCost(summary.totalCost) : '-'} |`);
  lines.push('');

  // Highlights section
  if (llmCalls.length > 0) {
    const highlights: string[] = [];

    // Slowest call
    const slowest = llmCalls.reduce((a, b) => (a.duration > b.duration ? a : b));
    highlights.push(
      `- **Slowest:** #${slowest.index} ${slowest.model} (${formatDuration(slowest.duration)})`,
    );

    // Most expensive call
    const withCost = llmCalls.filter((c) => c.cost !== null && c.cost > 0);
    if (withCost.length > 0) {
      const mostExpensive = withCost.reduce((a, b) => ((a.cost ?? 0) > (b.cost ?? 0) ? a : b));
      if (mostExpensive.cost !== null) {
        highlights.push(
          `- **Most Expensive:** #${mostExpensive.index} ${mostExpensive.model} (${formatCost(mostExpensive.cost)})`,
        );
      }
    }

    // Errors
    const errors = llmCalls.filter((c) => c.status === 'ERROR');
    if (errors.length > 0) {
      highlights.push(`- **Errors:** ${errors.map((e) => `#${e.index}`).join(', ')}`);
    }

    // Best cache utilization (by absolute tokens cached)
    const withCache = llmCalls.filter((c) => c.cacheReadTokens > 0);
    if (withCache.length > 0) {
      const bestCache = withCache.reduce((a, b) => (a.cacheReadTokens > b.cacheReadTokens ? a : b));
      highlights.push(
        `- **Most Cached:** #${bestCache.index} (${formatNumber(bestCache.cacheReadTokens)} cached / ${formatNumber(bestCache.newTokens)} new)`,
      );
    }

    if (highlights.length > 0) {
      lines.push('## Highlights');
      lines.push('');
      lines.push(highlights.join('\n'));
      lines.push('');
    }
  }

  // Visual timeline
  if (llmCalls.length > 1) {
    lines.push('## Visual Timeline');
    lines.push('');
    lines.push(renderGanttChart(llmCalls, summary.wallClockDuration));
    lines.push('');
  }

  // LLM Calls table
  if (llmCalls.length > 0) {
    lines.push('## LLM Calls');
    lines.push('');

    const hasCache = llmCalls.some((c) => c.cacheReadTokens > 0);

    if (hasCache) {
      lines.push(
        '| # | Start | Duration | Provider | Model | Tokens (in/out) | Cache (cached/new) | Cost | Status |',
      );
      lines.push(
        '|---|-------|----------|----------|-------|-----------------|-------------------|------|--------|',
      );
    } else {
      lines.push('| # | Start | Duration | Provider | Model | Tokens (in/out) | Cost | Status |');
      lines.push('|---|-------|----------|----------|-------|-----------------|------|--------|');
    }

    for (const call of llmCalls) {
      const tokensStr =
        call.totalTokens > 0
          ? `${formatNumber(call.promptTokens)}/${formatNumber(call.completionTokens)}`
          : '-';
      const costStr = call.cost !== null ? formatCost(call.cost) : '-';
      const statusStr = call.status === 'ERROR' ? 'ERROR' : 'OK';

      if (hasCache) {
        const cacheStr =
          call.cacheReadTokens > 0
            ? `${formatNumber(call.cacheReadTokens)}/${formatNumber(call.newTokens)}`
            : '-';
        lines.push(
          `| ${call.index} | ${formatOffset(call.startOffset)} | ${formatDuration(call.duration)} | ${call.provider} | ${call.model} | ${tokensStr} | ${cacheStr} | ${costStr} | ${statusStr} |`,
        );
      } else {
        lines.push(
          `| ${call.index} | ${formatOffset(call.startOffset)} | ${formatDuration(call.duration)} | ${call.provider} | ${call.model} | ${tokensStr} | ${costStr} | ${statusStr} |`,
        );
      }
    }
    lines.push('');
  }

  // Span Timeline with full details
  lines.push('## Span Timeline');
  lines.push('');
  lines.push('Format: **SpanName** [start → duration] | details');
  lines.push('');

  const tree = buildSpanTree(spans);
  lines.push(renderSpanTree(tree, traceStart));

  return lines.join('\n');
}
