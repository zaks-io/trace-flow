'use client';

import { useAuth0 } from '@auth0/auth0-react';

export function AuthButton() {
  const { isAuthenticated, isLoading, loginWithRedirect, logout, user } = useAuth0();

  if (isLoading) {
    return <div className="text-sm text-gray-600">Loading...</div>;
  }

  if (isAuthenticated) {
    return (
      <div className="flex items-center space-x-4">
        {user && <span className="text-sm text-gray-700">{user.name ?? user.email}</span>}
        <button
          onClick={() => {
            void logout({ logoutParams: { returnTo: window.location.origin } });
          }}
          className="text-sm font-medium text-gray-700 hover:text-gray-900"
        >
          Log out
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => {
        void loginWithRedirect({
          authorizationParams: {
            redirect_uri: typeof window !== 'undefined' ? `${window.location.origin}/app` : '',
          },
        });
      }}
      className="text-sm font-medium text-gray-700 hover:text-gray-900"
    >
      Log in
    </button>
  );
}
