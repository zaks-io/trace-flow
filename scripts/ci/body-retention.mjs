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

export function agentDeliveryRetentionRules(rules) {
  if (!Array.isArray(rules)) throw new Error('R2 lifecycle response is missing rules');
  const managedIds = new Set(['expire-agent-deliveries-4d', 'expire-agent-delivery-rows-4d']);
  const next = structuredClone(rules).filter((rule) => !managedIds.has(rule.id));
  for (const rule of next) {
    if (rule.actions) throw new Error(`Unsupported legacy lifecycle actions: ${rule.id}`);
    if (rule.enabled && rule.deleteObjectsTransition) {
      throw new Error(`Unexpected deletion policy in the agent delivery bucket: ${rule.id}`);
    }
  }
  for (const prefix of ['agent-deliveries/', 'agent-delivery-rows/']) {
    next.push({
      id:
        prefix === 'agent-deliveries/'
          ? 'expire-agent-deliveries-4d'
          : 'expire-agent-delivery-rows-4d',
      enabled: true,
      conditions: { prefix },
      deleteObjectsTransition: { condition: { type: 'Age', maxAge: 4 * 24 * 60 * 60 } },
    });
  }
  return next;
}
