export type DecisionType = 'choice' | 'score' | 'noul' | 'unknown';

export interface DecisionField {
  label: string;
  value: unknown;
  probability?: boolean;
  probabilities?: boolean;
}

export interface DecisionEntry {
  name: string;
  type: DecisionType;
  fields: DecisionField[];
}

export interface DecisionBodyData {
  kind: 'request' | 'response';
  state?: unknown;
  entries: DecisionEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decisionType(value: unknown): DecisionType {
  return value === 'choice' || value === 'score' || value === 'noul' ? value : 'unknown';
}

export function parseDecisionBody(
  body: unknown,
  kind: DecisionBodyData['kind'],
): DecisionBodyData | null {
  if (!isRecord(body)) return null;
  const entries = kind === 'request' ? body.questions : body.answers;
  if (!isRecord(entries)) return null;
  if (kind === 'request' && !Object.hasOwn(body, 'state')) return null;

  return {
    kind,
    ...(kind === 'request' ? { state: body.state } : {}),
    entries: Object.entries(entries).map(([name, entry]) => {
      const value = isRecord(entry) ? entry : {};
      const type = decisionType(value.type);
      let fields: DecisionField[];

      if (kind === 'request') {
        fields = [{ label: 'Instructions', value: value.instructions }];
        if (Object.hasOwn(value, 'criteria')) {
          fields.push({ label: 'Criteria', value: value.criteria });
        }
      } else if (type === 'noul') {
        fields = [{ label: 'Yes probability', value: value.noul, probability: true }];
      } else if (type === 'choice' || type === 'score') {
        fields = [
          {
            label: type === 'choice' ? 'Selected option' : 'Weighted score',
            value: type === 'choice' ? value.choice : value.score,
          },
          { label: 'Confidence', value: value.confidence, probability: true },
          { label: 'Probabilities', value: value.probabilities, probabilities: true },
        ];
        if (type === 'score') fields.push({ label: 'Legend', value: value.legend });
      } else {
        fields = [{ label: 'Captured value', value: entry }];
      }

      return { name, type, fields };
    }),
  };
}

export function formatDecisionValue(value: unknown, probability = false): string {
  if (value === undefined) return 'Unavailable';
  if (
    probability &&
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  ) {
    return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 4 })}%`;
  }
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export function decisionProbabilityEntries(value: unknown): [string, unknown][] | null {
  return isRecord(value) ? Object.entries(value) : null;
}
