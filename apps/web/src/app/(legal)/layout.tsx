import Link from 'next/link';
import { Zap } from 'lucide-react';

const navLinks = [
  { href: '/app', label: 'Dashboard' },
  { href: '/docs', label: 'Docs' },
];

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="bg-grid-pattern pointer-events-none fixed inset-0 opacity-[0.02]" />

      <div className="relative mx-auto max-w-[640px] px-6 pb-16 pt-8">
        <header className="mb-16 flex items-center justify-between">
          <Link
            href="/"
            className="group flex items-center gap-2.5 transition-opacity duration-200 hover:opacity-80"
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 ring-1 ring-primary/20">
              <Zap className="h-3.5 w-3.5 text-primary" />
            </div>
            <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-muted-foreground transition-colors duration-200 group-hover:text-foreground">
              Trace Flow
            </span>
          </Link>
          <nav className="flex items-center gap-1">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </header>

        <article>{children}</article>

        <footer className="mt-16 border-t border-border/50 pt-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <span className="font-mono text-[11px] text-muted-foreground/50">
              &copy; {new Date().getFullYear()} Zaks.io LLC
            </span>
            <nav className="flex flex-wrap gap-x-1 gap-y-1 text-xs text-muted-foreground/60">
              {[
                { href: '/', label: 'Home' },
                ...navLinks,
                { href: '/security', label: 'Security' },
                { href: '/terms', label: 'Terms' },
                { href: '/privacy', label: 'Privacy' },
              ].map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="rounded-md px-2 py-1 transition-colors hover:bg-muted hover:text-foreground"
                >
                  {link.label}
                </Link>
              ))}
            </nav>
          </div>
        </footer>
      </div>
    </main>
  );
}
