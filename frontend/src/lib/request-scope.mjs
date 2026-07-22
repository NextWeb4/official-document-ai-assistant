/**
 * Track whether an asynchronous result still belongs to the selected key.
 * Advancing the scope invalidates every token captured for the previous key.
 *
 * @template {string} Key
 * @param {Key} initialKey
 */
export function createRequestScope(initialKey) {
  let key = initialKey;
  let generation = 0;

  return {
    capture() {
      return { key, generation };
    },

    advance(nextKey) {
      key = nextKey;
      generation += 1;
    },

    isCurrent(token) {
      return token.key === key && token.generation === generation;
    },
  };
}
