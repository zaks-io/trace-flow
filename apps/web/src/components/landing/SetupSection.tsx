'use client';

import Link from 'next/link';
import { Route, SquareTerminal } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CodeExample } from './CodeExample';

const DESKTOP_STEPS = [
  {
    title: 'Install and sign in',
    description: 'Download the desktop app for macOS or Windows and connect it to your account.',
  },
  {
    title: 'Choose your sources',
    description: 'Review the coding agents it detects, then start syncing.',
  },
  {
    title: 'Keep working',
    description: 'It syncs from the menu bar or system tray. Pause it there whenever you like.',
  },
];

export function SetupSection() {
  return (
    <section id="setup" className="relative scroll-mt-8 bg-background py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-5xl">
          Set up in a few minutes.
        </h2>
        <p className="mt-5 max-w-2xl text-lg leading-8 text-muted-foreground">
          Start with the path that matches how you use models. You can add the other one later.
        </p>

        <Tabs defaultValue="desktop" className="mt-12 gap-8">
          <TabsList className="h-11 w-full sm:w-fit">
            <TabsTrigger value="desktop" className="px-4">
              <SquareTerminal strokeWidth={1.75} aria-hidden="true" />
              Desktop app
            </TabsTrigger>
            <TabsTrigger value="api" className="px-4">
              <Route strokeWidth={1.75} aria-hidden="true" />
              API proxy
            </TabsTrigger>
          </TabsList>

          <TabsContent value="desktop">
            <div className="grid gap-10 md:grid-cols-[1.4fr_1fr] md:gap-12">
              <ol className="space-y-7">
                {DESKTOP_STEPS.map(({ title, description }, index) => (
                  <li key={title} className="flex gap-4">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 font-mono text-sm text-primary">
                      {index + 1}
                    </span>
                    <div>
                      <h3 className="text-base font-semibold text-foreground">{title}</h3>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="self-start rounded-xl border border-border bg-card/50 p-6">
                <p className="text-sm leading-6 text-muted-foreground">
                  Works with Claude Code and Codex CLI on macOS and Windows. Cursor capture is macOS
                  only. Coding-agent analytics is in alpha.
                </p>
                <Link
                  href="/docs/collector"
                  className="mt-5 inline-flex h-10 items-center rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:border-primary/30 active:translate-y-px"
                >
                  Download the desktop app
                </Link>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="api">
            <p className="mb-6 max-w-2xl text-sm leading-6 text-muted-foreground">
              Keep your SDK. Change the base URL and add one header.
            </p>
            <CodeExample />
          </TabsContent>
        </Tabs>
      </div>
    </section>
  );
}
