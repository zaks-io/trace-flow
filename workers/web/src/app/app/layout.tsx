'use client';

import { ConvexReactClient, useQuery } from 'convex/react';
import { ConvexProviderWithAuth0 } from 'convex/react-auth0';
import { Auth0Provider } from '@auth0/auth0-react';
import { Authenticated, Unauthenticated, AuthLoading } from 'convex/react';
import Link from 'next/link';
import { useMemo } from 'react';
import { AuthButton } from '@/components/AuthButton';
import { api } from '../../../../../convex/_generated/api';

function AppContent({ children }: { children: React.ReactNode }) {
  const hasRole = useQuery(api.auth.hasObserveRole);

  return (
    <>
      <AuthLoading>
        <div className="min-h-screen bg-gray-50 flex justify-center items-center">
          <div className="text-gray-600">Loading...</div>
        </div>
      </AuthLoading>
      <Unauthenticated>
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
                    href="/app/requests"
                    className="inline-flex items-center px-1 pt-1 text-sm font-medium text-gray-900"
                  >
                    Requests
                  </Link>
                  <Link
                    href="/app/traces"
                    className="inline-flex items-center px-1 pt-1 text-sm font-medium text-gray-900"
                  >
                    Traces
                  </Link>
                  <Link
                    href="/app/api-keys"
                    className="inline-flex items-center px-1 pt-1 text-sm font-medium text-gray-900"
                  >
                    API Keys
                  </Link>
                </div>
                <div className="flex items-center">
                  <AuthButton />
                </div>
              </div>
            </div>
          </nav>
          <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-8 text-center">
              <h2 className="text-xl font-semibold text-blue-900 mb-2">Authentication Required</h2>
              <p className="text-blue-700">Please log in to access the dashboard.</p>
            </div>
          </main>
        </div>
      </Unauthenticated>
      <Authenticated>
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
                    href="/app/requests"
                    className="inline-flex items-center px-1 pt-1 text-sm font-medium text-gray-900"
                  >
                    Requests
                  </Link>
                  <Link
                    href="/app/traces"
                    className="inline-flex items-center px-1 pt-1 text-sm font-medium text-gray-900"
                  >
                    Traces
                  </Link>
                  <Link
                    href="/app/api-keys"
                    className="inline-flex items-center px-1 pt-1 text-sm font-medium text-gray-900"
                  >
                    API Keys
                  </Link>
                </div>
                <div className="flex items-center">
                  <AuthButton />
                </div>
              </div>
            </div>
          </nav>
          <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
            {hasRole === undefined ? (
              <div className="flex justify-center items-center py-12">
                <div className="text-gray-600">Loading...</div>
              </div>
            ) : hasRole === false ? (
              <div className="bg-red-50 border border-red-200 rounded-lg p-8 text-center">
                <h2 className="text-xl font-semibold text-red-900 mb-2">Access Denied</h2>
                <p className="text-red-700">
                  You need the &quot;Observe&quot; role to access this dashboard.
                </p>
              </div>
            ) : (
              children
            )}
          </main>
        </div>
      </Authenticated>
    </>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const convex = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL ?? '';
    return new ConvexReactClient(url);
  }, []);

  return (
    <Auth0Provider
      domain={process.env.NEXT_PUBLIC_AUTH0_DOMAIN ?? ''}
      clientId={process.env.NEXT_PUBLIC_AUTH0_CLIENT_ID ?? ''}
      authorizationParams={{
        redirect_uri: typeof window !== 'undefined' ? window.location.origin : '',
      }}
      useRefreshTokens={true}
      cacheLocation="localstorage"
    >
      <ConvexProviderWithAuth0 client={convex}>
        <AppContent>{children}</AppContent>
      </ConvexProviderWithAuth0>
    </Auth0Provider>
  );
}
