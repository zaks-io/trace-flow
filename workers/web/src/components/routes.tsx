import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router-dom';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Requests = lazy(() => import('./pages/Requests'));
const Traces = lazy(() => import('./pages/Traces'));
const TraceDetail = lazy(() => import('./pages/TraceDetail'));
const ApiKeys = lazy(() => import('./pages/ApiKeys'));
const Pricing = lazy(() => import('./pages/Pricing'));
const Alerts = lazy(() => import('./pages/Alerts'));

function PageLoader() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        Loading...
      </div>
    </div>
  );
}

function withSuspense(Component: React.LazyExoticComponent<() => React.ReactElement>) {
  return (
    <Suspense fallback={<PageLoader />}>
      <Component />
    </Suspense>
  );
}

export const routes: RouteObject[] = [
  {
    path: '/',
    element: withSuspense(Dashboard),
  },
  {
    path: '/requests/:traceId?',
    element: withSuspense(Requests),
  },
  {
    path: '/traces',
    element: withSuspense(Traces),
  },
  {
    path: '/trace/:traceId',
    element: withSuspense(TraceDetail),
  },
  {
    path: '/api-keys',
    element: withSuspense(ApiKeys),
  },
  {
    path: '/pricing',
    element: withSuspense(Pricing),
  },
  {
    path: '/alerts',
    element: withSuspense(Alerts),
  },
];

export const navItems = [
  { title: 'Dashboard', path: '/', fullPath: '/app' },
  { title: 'Requests', path: '/requests', fullPath: '/app/requests' },
  { title: 'Traces', path: '/traces', fullPath: '/app/traces' },
  { title: 'API Keys', path: '/api-keys', fullPath: '/app/api-keys' },
  { title: 'Pricing', path: '/pricing', fullPath: '/app/pricing' },
  { title: 'Alerts', path: '/alerts', fullPath: '/app/alerts' },
];
