import { ConvexProvider, ConvexReactClient } from 'convex/react';
import { Route, Switch } from 'wouter';
import AppPage from './AppPage';
import Traces from './Traces';

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);

export default function AppLayout() {
  return (
    <ConvexProvider client={convex}>
      <div className="min-h-screen bg-gray-50">
        <nav className="bg-white shadow-sm border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between h-16">
              <div className="flex space-x-8">
                <a
                  href="/app"
                  className="inline-flex items-center px-1 pt-1 text-sm font-medium text-gray-900"
                >
                  Dashboard
                </a>
                <a
                  href="/app/traces"
                  className="inline-flex items-center px-1 pt-1 text-sm font-medium text-gray-900"
                >
                  Traces
                </a>
              </div>
            </div>
          </div>
        </nav>
        <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
          <Switch>
            <Route path="/app" component={AppPage} />
            <Route path="/app/traces" component={Traces} />
          </Switch>
        </main>
      </div>
    </ConvexProvider>
  );
}
