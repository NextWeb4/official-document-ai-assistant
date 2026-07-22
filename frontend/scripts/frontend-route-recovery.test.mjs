import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parseDocumentId } from '../src/lib/document-id.mjs';

test('preview document IDs must be positive safe integers', () => {
  assert.equal(parseDocumentId('42'), 42);
  assert.equal(parseDocumentId(''), null);
  assert.equal(parseDocumentId('0'), null);
  assert.equal(parseDocumentId('-1'), null);
  assert.equal(parseDocumentId('2abc'), null);
  assert.equal(parseDocumentId('9007199254740992'), null);
});

test('routing retains an unknown-route fallback and reload-based recovery', async () => {
  const [appSource, boundarySource] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/ui/error-boundary.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(appSource, /<Route path="\*"/);
  assert.match(boundarySource, /handleReload[\s\S]*window\.location\.reload\(\)/);
  assert.match(boundarySource, /onClick=\{this\.handleReload\}/);
});
