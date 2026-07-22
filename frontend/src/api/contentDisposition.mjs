/**
 * Return the server-provided download name, preferring RFC 5987 filename*.
 * Invalid percent escapes are left intact so callers can still use the name.
 *
 * @param {string | null | undefined} disposition
 * @returns {string | null}
 */
export function filenameFromContentDisposition(disposition) {
  if (!disposition) return null;

  const extendedMatch = disposition.match(
    /(?:^|;)\s*filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i,
  );
  if (extendedMatch) {
    const value = (extendedMatch[1] ?? extendedMatch[2] ?? '').trim();
    const encoded = /^(?:UTF-8|UTF8)'[^']*'(.*)$/i.exec(value)?.[1];
    if (encoded !== undefined) {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    }
  }

  const plainMatch = disposition.match(
    /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/i,
  );
  const plain = plainMatch?.[1] ?? plainMatch?.[2];
  return plain ? plain.trim().replace(/\\(["\\])/g, '$1') : null;
}
