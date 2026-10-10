import { readFileSync } from 'node:fs';

const host = new URL(process.argv[2]);
if (host.protocol !== 'http:' || host.hostname !== '127.0.0.1') {
  throw new Error('Tinybird workspace discovery requires local loopback HTTP');
}
const token = readFileSync(0, 'utf8').trim();
if (!token) throw new Error('Tinybird Local did not return an admin token');
const response = await fetch(new URL('/v1/user/workspaces?with_organization=true', host), {
  headers: { Authorization: `Bearer ${token}` },
});
if (!response.ok) throw new Error(`Tinybird workspace discovery returned HTTP ${response.status}`);
const { workspaces } = await response.json();
const workspace = workspaces.find((entry) => entry.name === 'Tinybird_Local_Testing');
if (!workspace?.id) throw new Error('Tinybird Local default workspace is missing');
process.stdout.write(JSON.stringify({ id: workspace.id }));
