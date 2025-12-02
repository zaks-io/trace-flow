'use client';

import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '../../../../../../convex/_generated/api';
import { useState } from 'react';
import type { Id } from '../../../../../../convex/_generated/dataModel';

export default function ApiKeys() {
  const apiKeys = useQuery(api.apiKeys.list);
  const createApiKey = useMutation(api.apiKeys.create);
  const deleteApiKey = useMutation(api.apiKeys.remove);
  const syncToKV = useAction(api.apiKeys.syncToKV);

  const [isCreating, setIsCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<Id<'apiKeys'> | null>(null);
  const [syncingId, setSyncingId] = useState<Id<'apiKeys'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleCreateKey = async () => {
    setIsCreating(true);
    setError(null);
    setSuccess(null);

    const expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000;

    await createApiKey({ expiresAt });
    setSuccess('API key created successfully');
    setIsCreating(false);
  };

  const handleDeleteKey = async (id: Id<'apiKeys'>) => {
    setDeletingId(id);
    setError(null);
    setSuccess(null);

    await deleteApiKey({ id });
    setSuccess('API key deleted successfully');
    setDeletingId(null);
  };

  const handleSyncKey = async (id: Id<'apiKeys'>) => {
    setSyncingId(id);
    setError(null);
    setSuccess(null);

    const result = await syncToKV({ id });
    if (result.existed) {
      setSuccess('API key already exists in KV');
    } else {
      setSuccess('API key synced to KV');
    }
    setSyncingId(null);
  };

  const formatExpiration = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = Date.now();
    const isExpired = timestamp < now;

    return {
      formatted: date.toLocaleString(),
      isExpired,
    };
  };

  const isExpiringSoon = (timestamp: number) => {
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    return timestamp - now < sevenDays && timestamp > now;
  };

  return (
    <div>
      <div className="mb-6 flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">API Keys</h1>
          <p className="text-gray-600 mt-1">Manage your API keys for accessing the proxy service</p>
        </div>
        <button
          onClick={() => void handleCreateKey()}
          disabled={isCreating}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isCreating ? 'Creating...' : 'Create API Key'}
        </button>
      </div>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-600 text-sm">{error}</p>
        </div>
      )}

      {success && (
        <div className="mb-4 bg-green-50 border border-green-200 rounded-lg p-4">
          <p className="text-green-600 text-sm">{success}</p>
        </div>
      )}

      {apiKeys === undefined ? (
        <div className="flex justify-center items-center py-12">
          <div className="text-gray-600">Loading API keys...</div>
        </div>
      ) : apiKeys.length === 0 ? (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">No API keys found</p>
          <p className="text-gray-500 text-sm mt-2">Create your first API key to get started</p>
        </div>
      ) : (
        <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    API Key
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Expiration Date
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {apiKeys.map((apiKey) => {
                  const { formatted, isExpired } = formatExpiration(apiKey.expiresAt);
                  const expiringSoon = isExpiringSoon(apiKey.expiresAt);

                  return (
                    <tr key={apiKey._id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-mono">
                        {apiKey.key}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {formatted}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {isExpired ? (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                            Expired
                          </span>
                        ) : expiringSoon ? (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                            Expiring Soon
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                            Active
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm space-x-3">
                        <button
                          onClick={() => void handleSyncKey(apiKey._id)}
                          disabled={syncingId === apiKey._id}
                          className="text-blue-600 hover:text-blue-900 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                        >
                          {syncingId === apiKey._id ? 'Syncing...' : 'Sync'}
                        </button>
                        <button
                          onClick={() => {
                            if (
                              confirm(
                                `Are you sure you want to delete this API key?\n\n${apiKey.key}\n\nThis action cannot be undone.`,
                              )
                            ) {
                              void handleDeleteKey(apiKey._id);
                            }
                          }}
                          disabled={deletingId === apiKey._id}
                          className="text-red-600 hover:text-red-900 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                        >
                          {deletingId === apiKey._id ? 'Deleting...' : 'Delete'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="bg-gray-50 px-6 py-3 border-t border-gray-200">
            <p className="text-sm text-gray-600">
              Showing {apiKeys.length} {apiKeys.length === 1 ? 'key' : 'keys'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
