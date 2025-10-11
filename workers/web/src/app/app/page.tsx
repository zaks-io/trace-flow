'use client';

import { useQuery } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';

export default function AppPage() {
  const apiKeys = useQuery(api.apiKeys.list);

  return (
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
  );
}
