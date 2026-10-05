// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionBodyDetails } from '../DecisionBodyDetails';
import { parseDecisionBody, type DecisionBodyData } from '../decisionBody';

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  environment.IS_REACT_ACT_ENVIRONMENT = false;
});

async function render(data: DecisionBodyData) {
  await act(async () => root.render(<DecisionBodyDetails data={data} />));
}

describe('decision inspection', () => {
  it('shows the typed answer and supports collapsing it with a focusable control', async () => {
    const data = parseDecisionBody(
      { answers: { refund: { type: 'noul', noul: 0.98 } } },
      'response',
    )!;
    await render(data);
    expect(container.textContent).toContain('Yes probability');
    expect(container.textContent).toContain('98%');
    expect(container.textContent).not.toContain('Confidence');

    const button = container.querySelector('button')!;
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await act(async () => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Yes probability');
    await act(async () => button.click());
    expect(container.textContent).toContain('98%');
  });

  it('shows all Choice and Score fields, including zero probabilities', async () => {
    const data = parseDecisionBody(
      {
        answers: {
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
    )!;
    await render(data);
    for (const value of [
      'Selected option',
      'billing',
      '81%',
      '88%',
      '0%',
      'Weighted score',
      '1.05',
      '92%',
      'Legend',
      'Frustrated',
    ]) {
      expect(container.textContent).toContain(value);
    }
  });

  it('shows structured request fields and an explicit empty answer state', async () => {
    await render(
      parseDecisionBody(
        {
          state: { ticket: 'Charged twice' },
          questions: { urgent: { type: 'noul', instructions: ['Read ticket', 'Is this urgent?'] } },
        },
        'request',
      )!,
    );
    expect(container.textContent).toContain('State');
    expect(container.textContent).toContain('Charged twice');
    expect(container.textContent).toContain('Is this urgent?');
    await render(parseDecisionBody({ answers: {} }, 'response')!);
    expect(container.textContent).toContain('No answers captured');
  });
});
