export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  backoffMs = [1000, 2000],
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise((r) =>
          setTimeout(r, backoffMs[attempt] ?? backoffMs[backoffMs.length - 1]),
        );
      }
    }
  }
  throw lastErr;
}
