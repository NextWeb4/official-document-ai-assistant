/**
 * Parse a document query parameter without accepting partial or unsafe values.
 *
 * @param {string} value
 * @returns {number | null}
 */
export function parseDocumentId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
