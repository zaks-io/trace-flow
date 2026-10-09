import { formatStructuredValue } from './structuredValue';

export function StructuredValue({ label, value }: { label?: string; value: unknown }) {
  const rendered = formatStructuredValue(value);
  if (!rendered) return null;

  return (
    <div className="space-y-1">
      {label && <div className="font-medium text-muted-foreground">{label}</div>}
      <div className="max-h-56 overflow-auto whitespace-pre-wrap rounded border border-border/60 bg-muted/40 px-2 py-1 font-mono text-[11px] leading-relaxed">
        {rendered}
      </div>
    </div>
  );
}
