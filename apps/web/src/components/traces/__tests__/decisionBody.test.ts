import { describe, expect, it } from 'vitest';
import { formatDecisionValue, parseDecisionBody } from '../decisionBody';

describe('decision bodies', () => {
  it('preserves structured state, instructions and criteria', () => {
    const state = [{ role: 'user', text: 'I was charged twice.' }];
    const instructions = { question: 'Which team?', context: ['billing', 'support'] };
    const criteria = { billing: null, support: 'Other requests' };
    const parsed = parseDecisionBody(
      {
        state,
        questions: { department: { type: 'choice', instructions, criteria } },
      },
      'request',
    );

    expect(parsed?.state).toEqual(state);
    expect(parsed?.entries[0]).toEqual({
      name: 'department',
      type: 'choice',
      fields: [
        { label: 'Instructions', value: instructions },
        { label: 'Criteria', value: criteria },
      ],
    });
  });

  it('keeps Noul probability separate from Choice and Score confidence', () => {
    const parsed = parseDecisionBody(
      {
        answers: {
          refund: { type: 'noul', noul: 0, confidence: 0.9 },
          department: {
            type: 'choice',
            choice: 'billing',
            confidence: 0.81,
            probabilities: { billing: 0.88, sales: 0 },
          },
          frustration: {
            type: 'score',
            score: 1.05,
            confidence: 0.92,
            probabilities: { 0: 0, 1: 0.95, 2: 0.05 },
            legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Angry' },
          },
        },
      },
      'response',
    );

    expect(parsed?.entries[0].fields).toEqual([
      { label: 'Yes probability', value: 0, probability: true },
    ]);
    expect(parsed?.entries[1].fields.map((field) => field.label)).toEqual([
      'Selected option',
      'Confidence',
      'Probabilities',
    ]);
    expect(parsed?.entries[2].fields.map((field) => field.label)).toEqual([
      'Weighted score',
      'Confidence',
      'Probabilities',
      'Legend',
    ]);
    expect(formatDecisionValue(0, true)).toBe('0%');
  });

  it('leaves missing values unavailable and invalid probabilities unscaled', () => {
    expect(formatDecisionValue(undefined, true)).toBe('Unavailable');
    expect(formatDecisionValue(2, true)).toBe('2');
    expect(formatDecisionValue('0.5', true)).toBe('0.5');
    expect(
      parseDecisionBody({ answers: { refund: { type: 'noul' } } }, 'response')?.entries[0].fields[0]
        .value,
    ).toBeUndefined();
  });

  it('does not parse errors, truncated content, arrays or chat as decisions', () => {
    for (const body of [
      null,
      [],
      '{"answers":',
      { error: 'Invalid question' },
      { choices: [] },
      { state: 'hi', questions: [] },
    ]) {
      expect(parseDecisionBody(body, 'response')).toBeNull();
    }
    expect(parseDecisionBody({ questions: {} }, 'request')).toBeNull();
  });

  it('retains empty maps and unknown answer types for explicit display', () => {
    expect(parseDecisionBody({ answers: {} }, 'response')?.entries).toEqual([]);
    expect(
      parseDecisionBody({ answers: { unknown: { type: 'future', value: 0 } } }, 'response')
        ?.entries[0],
    ).toEqual({
      name: 'unknown',
      type: 'unknown',
      fields: [{ label: 'Captured value', value: { type: 'future', value: 0 } }],
    });
  });
});
