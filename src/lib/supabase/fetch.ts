/**
 * Retrying fetch for the Supabase clients.
 *
 * WHY THIS EXISTS
 *
 * Node's built-in fetch (undici) intermittently fails against the Supabase host
 * with ECONNRESET, measured on this machine at 1–2 successes out of 6, while
 * curl and Node's own `https` module both go 6/6 against the same URL. The
 * pattern — first request fine, subsequent ones reset — is undici reusing a
 * pooled keep-alive socket that the far end has already closed.
 *
 * The practical effect was that signing in was a coin flip: the Server Action
 * calls supabase-js, supabase-js calls fetch, and the user gets "couldn't reach
 * the authentication service" for no reason they can act on.
 *
 * WHY RETRYING IS SAFE HERE
 *
 * We only retry when fetch throws — a transport failure, meaning no response was
 * produced. A connection reset on a dead pooled socket happens before the
 * request is delivered, so replaying it cannot double-apply a mutation. Any
 * response at all, including a 4xx/5xx, is returned untouched and never retried;
 * that would risk repeating a real server-side effect.
 *
 * It also happens to be the behaviour this product wants anyway: patchy mobile
 * data is the normal case for the people this is built for.
 */

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 120;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const fetchWithRetry: typeof fetch = async (input, init) => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetch(input, init);
    } catch (error) {
      lastError = error;

      // An aborted request is the caller's intent, not a transport failure.
      if (init?.signal?.aborted) throw error;

      if (attempt < MAX_ATTEMPTS) {
        // Exponential backoff. Short, because a reset socket fails instantly
        // and a sign-in is blocking a person looking at a spinner.
        await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }

  throw lastError;
};
