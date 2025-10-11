'use client';

import { ConvexProvider, ConvexReactClient } from 'convex/react';
import Link from 'next/link';
import { useMemo } from 'react';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const convex = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL ?? '';
    return new ConvexReactClient(url);
  }, []);

  return (
    <ConvexProvider client={convex}>
      <div className="min-h-screen bg-gray-50">
        <nav className="bg-white shadow-sm border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between h-16">
              <div className="flex space-x-8">
                <Link
                  href="/app"
                  className="inline-flex items-center px-1 pt-1 text-sm font-medium text-gray-900"
                >
                  Dashboard
                </Link>
                <Link
                  href="/app/traces"
                  className="inline-flex items-center px-1 pt-1 text-sm font-medium text-gray-900"
                >
                  Traces
                </Link>
              </div>
            </div>
          </div>
        </nav>
        <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </ConvexProvider>
  );
}
