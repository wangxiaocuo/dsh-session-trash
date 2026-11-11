/**
 * Small concurrency helpers shared by the trash services.
 *
 * @module dsh-session-trash/concurrency
 */

/**
 * Run `worker` over every item with a bounded number of in-flight operations.
 * Results keep the input order; the first rejection stops the remaining work and
 * rejects the returned promise.
 *
 * @param {readonly T[]} items input items.
 * @param {number} limit maximum in-flight operations.
 * @param {(item: T, index: number) => Promise<R>} worker per-item operation.
 * @returns {Promise<R[]>} results in input order.
 * @template T, R
 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}
