// Wraps a Shiprocket call with exponential-backoff retry. Used by
// shipmentJobQueue.service.js so a transient Shiprocket outage resumes on
// its own instead of leaving a shipment stuck.

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retries only on 5xx responses or network-level failures (DNS/timeout/
// connection reset) — never on 4xx, since a 4xx means the request itself is
// wrong (bad pincode, malformed payload, etc.) and retrying it unchanged
// just reproduces the same error. The one 401 case (expired token) is
// already retried once, tighter and separately, inside shiprocketFetch
// itself — untouched by this wrapper.
function isRetryable(err) {
  if (err?.isNetworkError) return true;
  if (typeof err?.status === 'number') return err.status >= 500;
  return false; // unrecognized error shape — fail fast rather than guess
}

async function withRetry(fn, { maxAttempts = MAX_ATTEMPTS, label = 'shiprocket call' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxAttempts) throw err;
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`[shiprocket-retry] ${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms: ${err.message}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = { withRetry, isRetryable };
