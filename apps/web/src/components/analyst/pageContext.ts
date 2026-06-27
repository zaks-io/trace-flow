export interface AnalystPageContextReference {
  surface: 'agents';
  objectId: string;
  label: string;
  route: string;
  filters?: Record<string, string | number | boolean | null>;
}

export function pageContextKey(ref: AnalystPageContextReference): string {
  return `${ref.surface}:${ref.objectId}`;
}

export function buildMessagePageContextReferences(
  pathname: string,
  selectedReferences: AnalystPageContextReference[],
): AnalystPageContextReference[] {
  return dedupePageContextReferences([
    ...ambientPageContextReferences(pathname),
    ...selectedReferences,
  ]);
}

function ambientPageContextReferences(pathname: string): AnalystPageContextReference[] {
  // Match the Agents page and its descendants only — not sibling routes like /app/agentship.
  if (pathname !== '/app/agents' && !pathname.startsWith('/app/agents/')) return [];
  return [
    {
      surface: 'agents',
      objectId: 'agents-page',
      label: 'Agent Analytics page',
      route: pathname,
      filters: {},
    },
  ];
}

function dedupePageContextReferences(
  references: AnalystPageContextReference[],
): AnalystPageContextReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = pageContextKey(reference);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
