'use client';

import { useQuery } from 'convex/react';
import { Authenticated, Unauthenticated, AuthLoading } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';

export default function AppPage() {
  const apiKeys = useQuery(api.apiKeys.list);

  return (
    <>
      <AuthLoading>
        <div className="flex justify-center items-center py-12">
          <div className="text-gray-600">Loading...</div>
        </div>
      </AuthLoading>
      <Unauthenticated>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-8 text-center">
          <h2 className="text-xl font-semibold text-blue-900 mb-2">Authentication Required</h2>
          <p className="text-blue-700">Please log in to view the dashboard.</p>
        </div>
      </Unauthenticated>
      <Authenticated>
        <div>
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
            <p className="text-gray-600 mt-1">LLM Request Analytics Dashboard</p>
          </div>

          <div className="bg-white shadow-sm rounded-lg border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">API Keys</h2>
            {apiKeys === undefined ? (
              <p className="text-gray-600">Loading...</p>
            ) : apiKeys.length === 0 ? (
              <p className="text-gray-600">No API keys found</p>
            ) : (
              <div className="space-y-2">
                {apiKeys.map((apiKey) => (
                  <div key={apiKey._id} className="p-3 bg-gray-50 rounded border border-gray-200">
                    <p className="text-sm">
                      <strong className="text-gray-700">Key:</strong>{' '}
                      <span className="font-mono text-gray-900">{apiKey.key}</span>
                    </p>
                    <p className="text-sm mt-1">
                      <strong className="text-gray-700">Expires:</strong>{' '}
                      <span className="text-gray-900">
                        {new Date(apiKey.expiresAt).toLocaleString()}
                      </span>
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Authenticated>
    </>
  );
}
