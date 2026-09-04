import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bodyRetentionRules } from './body-retention.mjs';

test('narrows the managed expiration without removing unrelated rules', () => {
  const rules = [
    {
      id: 'auto-expire-30d',
      enabled: true,
      conditions: { prefix: '' },
      deleteObjectsTransition: { condition: { type: 'Age', maxAge: 2592000 } },
    },
    {
      id: 'multipart',
      enabled: true,
      conditions: { prefix: '' },
      abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 604800 } },
    },
  ];
  const result = bodyRetentionRules(rules);
  assert.equal(result[0].conditions.prefix, 'bodies/');
  assert.deepEqual(result[1], rules[1]);
  assert.equal(rules[0].conditions.prefix, '');
  assert.deepEqual(bodyRetentionRules(result), result);
});

test('refuses unrelated expiration rules that overlap pending deliveries', () => {
  for (const prefix of ['', 'trace-', 'trace-deliveries/', 'trace-deliveries/one']) {
    assert.throws(
      () =>
        bodyRetentionRules([
          {
            id: 'custom',
            enabled: true,
            conditions: { prefix },
            deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86400 } },
          },
        ]),
      /would delete pending/,
    );
  }
});

test('does not introduce expiration where none existed and rejects missing policy data', () => {
  assert.deepEqual(bodyRetentionRules([]), []);
  assert.throws(() => bodyRetentionRules(undefined), /missing rules/);
});
