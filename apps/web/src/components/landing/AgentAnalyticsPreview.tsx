const COST_POINTS =
  '0,108 42,99 84,104 126,82 168,87 210,61 252,72 294,47 336,54 378,29 420,39 462,16';

const CONTEXT_BARS = [35, 42, 38, 55, 62, 51, 74, 67, 82, 71, 58, 44];

export function AgentAnalyticsPreview() {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border/90 bg-[oklch(0.145_0.006_270)] shadow-[0_28px_100px_oklch(0_0_0/0.45)]">
      <div className="flex h-11 items-center justify-between border-b border-border/70 px-4">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5" aria-hidden="true">
            <span className="h-2 w-2 rounded-full bg-muted-foreground/25" />
            <span className="h-2 w-2 rounded-full bg-muted-foreground/25" />
            <span className="h-2 w-2 rounded-full bg-muted-foreground/25" />
          </div>
          <span className="ml-2 font-mono text-[10px] text-muted-foreground">
            trace-flow.dev/app/agents
          </span>
        </div>
        <span className="rounded border border-primary/25 bg-primary/8 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.14em] text-primary">
          Illustrative data
        </span>
      </div>

      <div className="grid min-h-[510px] grid-cols-[48px_1fr] sm:grid-cols-[164px_1fr]">
        <aside className="border-r border-border/70 bg-[oklch(0.135_0.006_270)] p-2 sm:p-3">
          <div className="mb-7 hidden items-center gap-2 px-2 pt-1 sm:flex">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-primary/12 text-primary">
              <PulseIcon />
            </span>
            <span className="font-mono text-[11px] font-semibold">Trace Flow</span>
          </div>
          <div className="space-y-1">
            <SidebarItem label="Overview" icon={<GridIcon />} />
            <SidebarItem label="Agents" icon={<AgentIcon />} active />
            <SidebarItem label="Requests" icon={<ListIcon />} />
            <SidebarItem label="Operations" icon={<BarsIcon />} />
          </div>
        </aside>

        <div className="min-w-0 p-3 sm:p-5">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
                Agent analytics
              </div>
              <div className="mt-1 text-base font-semibold tracking-tight text-foreground sm:text-lg">
                Where agent work turns into spend
              </div>
            </div>
            <div className="hidden items-center gap-2 sm:flex">
              <Filter label="Claude + Codex" />
              <Filter label="Last 30 days" />
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-12">
            <div className="rounded-lg border border-border/75 bg-card/55 p-4 lg:col-span-8">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-[10px] text-muted-foreground">Estimated cost over time</div>
                  <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground">
                    $164.20
                  </div>
                </div>
                <span className="rounded bg-[oklch(0.7_0.12_150/0.1)] px-2 py-1 font-mono text-[9px] text-[oklch(0.74_0.13_150)]">
                  -8.4%
                </span>
              </div>
              <div className="mt-3 h-[122px] w-full">
                <svg
                  viewBox="0 0 462 122"
                  preserveAspectRatio="none"
                  className="h-full w-full"
                  aria-label="Mock daily agent cost chart"
                >
                  <defs>
                    <linearGradient id="agent-cost-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="oklch(0.65 0.2 35)" stopOpacity="0.28" />
                      <stop offset="1" stopColor="oklch(0.65 0.2 35)" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M0 30H462M0 70H462M0 110H462"
                    stroke="oklch(0.28 0.006 270)"
                    strokeWidth="1"
                  />
                  <polygon points={`${COST_POINTS} 462,122 0,122`} fill="url(#agent-cost-fill)" />
                  <polyline
                    points={COST_POINTS}
                    fill="none"
                    stroke="oklch(0.68 0.2 35)"
                    strokeWidth="2.5"
                    vectorEffect="non-scaling-stroke"
                  />
                  <circle cx="462" cy="16" r="3.5" fill="oklch(0.68 0.2 35)" />
                </svg>
              </div>
              <div className="mt-1 flex justify-between font-mono text-[8px] text-muted-foreground/70">
                <span>Aug 04</span>
                <span>Aug 11</span>
                <span>Aug 18</span>
                <span>Sep 01</span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 lg:col-span-4 lg:grid-cols-1">
              <Stat label="Tokens processed" value="83.4M" note="63% generated" />
              <Stat label="Conversations" value="148" note="12 active days" />
              <Stat label="Projected 30d" value="$182" note="active-day pace" />
            </div>

            <div className="rounded-lg border border-border/75 bg-card/55 p-4 lg:col-span-7">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-muted-foreground">Per-turn context size</div>
                  <div className="mt-1 text-xs font-medium">
                    See pressure build before a session runs away
                  </div>
                </div>
                <span className="font-mono text-[9px] text-muted-foreground">p50 / p90</span>
              </div>
              <div className="mt-5 flex h-20 items-end gap-1.5">
                {CONTEXT_BARS.map((height, index) => (
                  <div key={index} className="relative flex h-full flex-1 items-end">
                    <div
                      className="w-full rounded-sm bg-primary/65"
                      style={{ height: `${height}%`, opacity: 0.45 + index * 0.035 }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-2 flex justify-between font-mono text-[8px] text-muted-foreground/70">
                <span>early turns</span>
                <span>conversation depth</span>
                <span>late turns</span>
              </div>
            </div>

            <div className="rounded-lg border border-border/75 bg-card/55 p-4 lg:col-span-5">
              <div className="text-[10px] text-muted-foreground">Notable changes</div>
              <div className="mt-3 space-y-3">
                <Signal color="bg-chart-2" label="Context above 140k" value="7 sessions" />
                <Signal color="bg-chart-4" label="Edit failures" value="11.2%" />
                <Signal color="bg-chart-3" label="Cost per review" value="$4.18" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SidebarItem({
  label,
  icon,
  active = false,
}: {
  label: string;
  icon: React.ReactNode;
  active?: boolean;
}) {
  return (
    <div
      className={`flex h-8 items-center justify-center gap-2 rounded-md px-2 sm:justify-start ${active ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}
    >
      <span className="h-4 w-4">{icon}</span>
      <span className="hidden text-[11px] sm:block">{label}</span>
    </div>
  );
}

function Filter({ label }: { label: string }) {
  return (
    <span className="rounded-md border border-border bg-background/60 px-2.5 py-1.5 font-mono text-[9px] text-muted-foreground">
      {label}
    </span>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-border/75 bg-card/55 p-3">
      <div className="text-[8px] text-muted-foreground sm:text-[10px]">{label}</div>
      <div className="mt-1 font-mono text-sm font-semibold tabular-nums sm:text-lg">{value}</div>
      <div className="mt-1 hidden text-[9px] text-muted-foreground sm:block">{note}</div>
    </div>
  );
}

function Signal({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
      <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{label}</span>
      <span className="font-mono text-[9px] text-foreground">{value}</span>
    </div>
  );
}

function PulseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 12h4l2-6 5 12 2-6h5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" />
      <rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" />
      <rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" />
      <rect x="14" y="14" width="7" height="7" rx="1" stroke="currentColor" />
    </svg>
  );
}
function AgentIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="7" width="16" height="12" rx="3" stroke="currentColor" />
      <path d="M9 12h.01M15 12h.01M9 16h6M12 7V4" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}
function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
function BarsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 20V10M10 20V4M16 20v-7M22 20H2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
