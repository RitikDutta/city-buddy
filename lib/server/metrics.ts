type Sample = { count: number; totalMs: number; maxMs: number };
const shared = globalThis as typeof globalThis & {
  cityBuddyMetrics?: Record<string, Sample>;
};
const samples = (shared.cityBuddyMetrics ??= {});

export function recordMetric(name: string, elapsedMs = 0) {
  const sample = (samples[name] ??= { count: 0, totalMs: 0, maxMs: 0 });
  sample.count += 1;
  sample.totalMs += elapsedMs;
  sample.maxMs = Math.max(sample.maxMs, elapsedMs);
}

export function metrics() {
  return Object.fromEntries(
    Object.entries(samples).map(([name, sample]) => [
      name,
      {
        count: sample.count,
        averageMs: Math.round((sample.totalMs / sample.count) * 100) / 100,
        maxMs: Math.round(sample.maxMs * 100) / 100,
      },
    ]),
  );
}
