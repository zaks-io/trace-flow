export function Section({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-baseline gap-3 text-sm font-semibold text-foreground">
        <span className="font-mono text-[11px] tabular-nums text-primary/40">
          {String(number).padStart(2, '0')}
        </span>
        {title}
      </h2>
      <div className="space-y-3 pl-8 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}
