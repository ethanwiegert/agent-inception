/** Ring buffer of frame intervals, read by the test harness via `globalThis.__perf`. */
export function createFrameStats(capacity = 600) {
  const intervals = new Float32Array(capacity);
  let count = 0;
  let last = -1;

  return {
    tick(now: number) {
      if (last >= 0) intervals[count++ % capacity] = now - last;
      last = now;
    },
    summary() {
      const n = Math.min(count, capacity);
      const sorted = intervals.slice(0, n).sort();
      const at = (q: number) => sorted[Math.min(n - 1, Math.floor(q * n))] ?? 0;
      const mean = n ? sorted.reduce((a, b) => a + b, 0) / n : 0;
      return { frames: count, meanMs: mean, p50Ms: at(0.5), p99Ms: at(0.99), maxMs: at(1) };
    },
  };
}
