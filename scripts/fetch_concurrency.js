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
  mapConcurrent
};
