import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequestScope } from '../src/lib/request-scope.mjs';

test('provider switch invalidates results captured for the previous provider', () => {
  const scope = createRequestScope('openai');
  const openAiRequest = scope.capture();

  scope.advance('ollama');

  assert.equal(scope.isCurrent(openAiRequest), false);
  assert.equal(scope.isCurrent(scope.capture()), true);
});

test('reselecting a provider still invalidates its older requests', () => {
  const scope = createRequestScope('openai');
  const olderRequest = scope.capture();

  scope.advance('openai');

  assert.equal(scope.isCurrent(olderRequest), false);
});
