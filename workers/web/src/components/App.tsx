import { useMemo } from 'react';
import { BrowserRouter, useRoutes } from 'react-router-dom';
import { Auth0Provider } from '@auth0/auth0-react';
import { ConvexReactClient } from 'convex/react';
import { ConvexProviderWithAuth0 } from 'convex/react-auth0';
import { AppLayout } from './AppLayout';
import { routes } from './routes';
import { useInitializeUser } from '../hooks/useInitializeUser';

function AppRoutes() {
  useInitializeUser();
  const element = useRoutes(routes);
  return <AppLayout>{element}</AppLayout>;
}

export function App() {
  const convex = useMemo(() => {
    const url = import.meta.env.NEXT_PUBLIC_CONVEX_URL ?? '';
    return new ConvexReactClient(url);
  }, []);

  const redirectUri = typeof window !== 'undefined' ? `${window.location.origin}/app` : '';

  return (
    <BrowserRouter basename="/app">
      <Auth0Provider
        domain={import.meta.env.NEXT_PUBLIC_AUTH0_DOMAIN ?? ''}
        clientId={import.meta.env.NEXT_PUBLIC_AUTH0_CLIENT_ID ?? ''}
        authorizationParams={{
          redirect_uri: redirectUri,
          scope: 'openid profile email offline_access',
        }}
        useRefreshTokens={true}
        cacheLocation="localstorage"
      >
        <ConvexProviderWithAuth0 client={convex}>
          <AppRoutes />
        </ConvexProviderWithAuth0>
      </Auth0Provider>
    </BrowserRouter>
  );
}
