function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headerValue(headers = {}, name) {
  if (!headers || !name) return '';
  if (typeof headers.get === 'function') return headers.get(name) || headers.get(name.toLowerCase()) || '';
  return headers[name] || headers[name.toLowerCase()] || '';
}

function retryAfterDelayMs(headers = {}, fallbackMs = 0) {
  const raw = String(headerValue(headers, 'Retry-After') || '').trim();
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const retryDate = Date.parse(raw);
    if (!Number.isNaN(retryDate)) return Math.max(0, retryDate - Date.now());
  }
  return Math.max(0, Number(fallbackMs) || 0);
}

async function withRetry(operation, options = {}) {
  if (typeof operation !== 'function') throw new Error('withRetry requires an operation function.');
  const retries = Number.isFinite(Number(options.retries))
    ? Math.max(0, Math.floor(Number(options.retries)))
    : 0;
  const fallbackDelayMs = Math.max(0, Number(options.delayMs) || 0);
  const sleepFn = options.sleep || sleep;
  const shouldRetryError = typeof options.shouldRetryError === 'function'
    ? options.shouldRetryError
    : () => false;
  const shouldRetryResult = typeof options.shouldRetryResult === 'function'
    ? options.shouldRetryResult
    : () => false;
  const headersForResult = typeof options.headersForResult === 'function'
    ? options.headersForResult
    : (result) => result?.headers;
  const headersForError = typeof options.headersForError === 'function'
    ? options.headersForError
    : (error) => error?.headers;
  let attempt = 0;

  // Retry policy is opt-in at each provider boundary so callers decide which
  // stale-data or fallback contract applies after a failure.
  while (true) {
    try {
      const result = await operation({ attempt });
      if (attempt >= retries || !shouldRetryResult(result, { attempt })) return result;
      attempt += 1;
      await sleepFn(retryAfterDelayMs(headersForResult(result), fallbackDelayMs));
    } catch (error) {
      if (attempt >= retries || !shouldRetryError(error, { attempt })) throw error;
      attempt += 1;
      await sleepFn(retryAfterDelayMs(headersForError(error), fallbackDelayMs));
    }
  }
}

async function mapConcurrent(items, concurrency, worker, options = {}) {
  // Preserve input order in results while limiting simultaneous provider calls.
  // Callers own retry policy; this helper only coordinates execution.
  const results = new Array(items.length);
  const limit = Math.min(Math.max(1, Math.trunc(Number(concurrency)) || 1), items.length);
  const delayMs = Math.max(0, Number(options.delayMs) || 0);
  let next = 0;

  if (!items.length) return results;
  if (delayMs && typeof options.sleep !== 'function') {
    throw new Error('mapConcurrent delayMs requires options.sleep.');
  }

  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      const result = await worker(item, index);
      results[index] = result;
      if (options.onSuccess) await options.onSuccess(item, index, result);
      if (delayMs) await options.sleep(delayMs);
    }
  }

  await Promise.all(Array.from({ length: limit }, run));
  return results;
}

module.exports = {
  mapConcurrent,
  retryAfterDelayMs,
  sleep,
  withRetry
};
