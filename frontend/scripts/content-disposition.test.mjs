import assert from 'node:assert/strict';
import test from 'node:test';

import { filenameFromContentDisposition } from '../src/api/contentDisposition.mjs';

test('decodes an RFC 5987 UTF-8 filename', () => {
  assert.equal(
    filenameFromContentDisposition(
      "attachment; filename*=UTF-8''%E5%85%AC%E6%96%87%E6%A0%A1%E5%AE%A1.docx",
    ),
    '公文校审.docx',
  );
});

test('prefers filename* over a plain compatibility filename', () => {
  assert.equal(
    filenameFromContentDisposition(
      "attachment; filename=download.docx; filename*=utf-8'zh-CN'%E7%BA%A2%E5%A4%B4%E6%96%87%E4%BB%B6.docx",
    ),
    '红头文件.docx',
  );
});

test('supports quoted plain filenames', () => {
  assert.equal(
    filenameFromContentDisposition('attachment; filename="review report.docx"'),
    'review report.docx',
  );
});

test('preserves an invalid percent-encoded filename instead of throwing', () => {
  assert.equal(
    filenameFromContentDisposition("attachment; filename*=UTF-8''broken%ZZ.docx"),
    'broken%ZZ.docx',
  );
});

test('returns null when no filename parameter exists', () => {
  assert.equal(filenameFromContentDisposition('attachment'), null);
  assert.equal(filenameFromContentDisposition(null), null);
});
