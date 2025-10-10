import { ConvexProvider, ConvexReactClient } from 'convex/react';
import { useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

function Dashboard() {
  const apiKeys = useQuery(api.apiKeys.list);

  return (
    <div>
      <h1>Observe</h1>
      <p>LLM Request Analytics Dashboard</p>

      <h2>API Keys</h2>
      {apiKeys === undefined ? (
        <p>Loading...</p>
      ) : apiKeys.length === 0 ? (
        <p>No API keys found</p>
      ) : (
        <ul>
          {apiKeys.map((apiKey) => (
            <li key={apiKey._id}>
              <strong>Key:</strong> {apiKey.key} | <strong>Expires:</strong>{' '}
              {new Date(apiKey.expiresAt).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function AppPage() {
  return (
    <ConvexProvider client={convex}>
      <Dashboard />
    </ConvexProvider>
  );
}
