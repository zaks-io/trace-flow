'use client';

import { useState } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

export interface Segment {
  key: string;
  label: string;
  value: number;
  color: string;
}

export interface InlineLabel {
  label: string;
  value: string;
  color: string;
}

interface Delta {
  percent: number;
  label: string;
}

interface BarCardProps {
  label: string;
  value: string;
  segments: Segment[];
  total: number;
  accent: string;
  formatter: (n: number) => string;
  inlineLabels?: InlineLabel[];
  showPercent?: boolean;
  compact?: boolean;
  delta?: Delta;
  invertDelta?: boolean;
}

function DeltaBadge({ delta, invert }: { delta: Delta; invert?: boolean }) {
  const isUp = delta.percent > 0;
  const isNeutral = delta.percent === 0;
  const isPositive = invert ? !isUp : isUp;

  const Icon = isNeutral ? Minus : isUp ? TrendingUp : TrendingDown;
  const color = isNeutral
    ? 'text-muted-foreground'
    : isPositive
      ? 'text-emerald-400'
      : 'text-red-400';

  return (
    <div className={`flex items-center gap-1 text-xs font-medium ${color}`}>
      <Icon className="h-3 w-3" />
      {!isNeutral && (
        <span className="font-mono tabular-nums">{Math.abs(delta.percent).toFixed(1)}%</span>
      )}
    </div>
  );
}

export function BarCard({
  label,
  value,
  segments,
  total,
  accent,
  formatter,
  inlineLabels,
  showPercent = true,
  compact = false,
  delta,
  invertDelta,
}: BarCardProps) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const hoveredSeg = hoveredKey ? segments.find((s) => s.key === hoveredKey) : null;

  const hasBar = segments.length > 0 && total > 0;
  const resolvedLabels =
    inlineLabels ??
    (hasBar
      ? segments
          .filter((seg) => seg.value > 0 && seg.color !== 'transparent')
          .map((seg) => ({ label: seg.label, value: formatter(seg.value), color: seg.color }))
      : null);

  return (
    <div
      className={`relative min-w-0 rounded-xl bg-linear-to-br ${accent} ${compact ? 'p-3' : 'p-5'}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground">{label}</p>
          <p
            className={`font-mono font-medium tabular-nums text-foreground ${compact ? 'mt-1 text-xl' : 'mt-2 text-3xl'}`}
          >
            {value}
          </p>
        </div>
        {delta && <DeltaBadge delta={delta} invert={invertDelta} />}
      </div>
      {hasBar && (
        <div className={`relative ${compact ? 'mt-2' : 'mt-3'}`}>
          {hoveredSeg && (
            <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-3 py-1.5 text-xs shadow-lg">
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ backgroundColor: hoveredSeg.color }}
                />
                <span className="font-medium text-foreground">{hoveredSeg.label}</span>
              </div>
              {showPercent && (
                <div className="mt-0.5 font-mono tabular-nums text-muted-foreground">
                  {formatter(hoveredSeg.value)} · {((hoveredSeg.value / total) * 100).toFixed(1)}%
                </div>
              )}
            </div>
          )}
          <div className="flex h-1.5 w-full overflow-hidden rounded-full">
            {segments.map((seg) => {
              const pct = (seg.value / total) * 100;
              const isHovered = hoveredKey === seg.key;

              return (
                <div
                  key={seg.key}
                  className="h-full transition-opacity duration-150"
                  style={{
                    flexBasis: `${pct}%`,
                    flexShrink: 0,
                    backgroundColor: seg.color,
                    opacity: hoveredKey && !isHovered ? 0.4 : 0.7,
                  }}
                  onMouseEnter={() => setHoveredKey(seg.key)}
                  onMouseLeave={() => setHoveredKey(null)}
                />
              );
            })}
          </div>
        </div>
      )}
      {resolvedLabels && resolvedLabels.length > 0 && (
        <div
          className={`${hasBar ? 'mt-1.5' : compact ? 'mt-2' : 'mt-3'} flex flex-wrap gap-x-2 gap-y-0.5`}
        >
          {resolvedLabels.map((item) => (
            <span
              key={item.label}
              className="flex items-center gap-1 text-[10px] text-muted-foreground"
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: item.color, opacity: 0.7 }}
              />
              <span className="font-mono tabular-nums">{item.value}</span>
              <span>{item.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function formatCompact(n: number): string {
  if (n === 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function formatCostCompact(dollars: number): string {
  if (dollars === 0) return '$0';
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  if (dollars >= 0.01) return `$${dollars.toFixed(3)}`;
  if (dollars >= 0.0001) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(6)}`;
}
