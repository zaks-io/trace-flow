/** Shared two-column (icon · body) layout for every Pi run row, with the timeline rail. */
export function PiRunRowShell({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex gap-2 pl-0.5">
      <div className="relative flex flex-col items-center">
        <span className="z-10 mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
          {icon}
        </span>
        <span className="mt-0.5 w-px flex-1 bg-border/70 last:hidden" aria-hidden />
      </div>
      <div className="min-w-0 flex-1 pb-2">{children}</div>
    </div>
  );
}
