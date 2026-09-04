export function SummaryCard({
  title,
  value,
  description,
  icon,
  accentColor,
}: {
  title: string;
  value: string;
  description: string;
  icon: React.ReactNode;
  accentColor: string;
}) {
  return (
    <div
      className="rounded-lg border border-border/60 border-l-2 p-4"
      style={{ borderLeftColor: accentColor }}
    >
      <div className="flex items-start justify-between">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">{title}</p>
        <div style={{ color: accentColor }}>{icon}</div>
      </div>
      <p className="tabular-mono mt-2 text-3xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
