export function bodyRetentionRules(rules) {
  if (!Array.isArray(rules)) throw new Error('R2 lifecycle response is missing rules');
  const next = structuredClone(rules);
  const managed = next.find((rule) => rule.id === 'auto-expire-30d');
  if (managed) {
    if (!['', 'bodies/'].includes(managed.conditions?.prefix)) {
      throw new Error('Unexpected scope for the managed body retention rule');
    }
    managed.conditions = { ...managed.conditions, prefix: 'bodies/' };
  }
  for (const rule of next) {
    if (rule.actions) throw new Error(`Unsupported legacy lifecycle actions: ${rule.id}`);
    if (!rule.enabled || !rule.deleteObjectsTransition) continue;
    const prefix = rule.conditions?.prefix;
    if (typeof prefix !== 'string') throw new Error(`Missing lifecycle prefix: ${rule.id}`);
    if ('trace-deliveries/'.startsWith(prefix) || prefix.startsWith('trace-deliveries/')) {
      throw new Error(`Lifecycle rule ${rule.id} would delete pending trace deliveries`);
    }
  }
  return next;
}

const ANALYST_BACKUP_TTL_SECONDS = 7 * 24 * 60 * 60;

export function analystBackupRetentionRules(rules) {
  if (!Array.isArray(rules)) throw new Error('R2 lifecycle response is missing rules');
  const next = structuredClone(rules);
  const managedRule = {
    id: 'expire-analyst-snapshots-7d',
    enabled: true,
    conditions: { prefix: 'snapshots/' },
    deleteObjectsTransition: {
      condition: { type: 'Age', maxAge: ANALYST_BACKUP_TTL_SECONDS },
    },
  };
  const managedIndex = next.findIndex((rule) => rule.id === managedRule.id);
  if (managedIndex === -1) next.push(managedRule);
  else next[managedIndex] = managedRule;
  return next;
}
