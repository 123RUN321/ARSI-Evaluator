/** Switch sources at a download boundary after the primary source handles its retries. */
export async function withSourceFallback<T>(primary: () => Promise<T>, fallback: () => Promise<T>, options: {
  signal: AbortSignal;
  shouldFallback: (error: unknown) => boolean;
  onFallback: () => void;
}): Promise<T> {
  options.signal.throwIfAborted();
  try { return await primary(); }
  catch (primaryError) {
    options.signal.throwIfAborted();
    if (!options.shouldFallback(primaryError)) throw primaryError;
    options.onFallback();
    options.signal.throwIfAborted();
    try { return await fallback(); }
    catch (fallbackError) {
      options.signal.throwIfAborted();
      throw new AggregateError([primaryError, fallbackError], "Primary and fallback sources both failed");
    }
  }
}

export function withSourceFallbacks<T>(source: string, fallbacks: readonly string[], attempt: (url: string) => Promise<T>, options: {
  signal: AbortSignal;
  shouldFallback: (error: unknown) => boolean;
  onFallback: (source: string, fallback: string) => void;
}): Promise<T> {
  const [next, ...remaining] = fallbacks;
  if (!next) return attempt(source);
  return withSourceFallback(() => attempt(source), () => withSourceFallbacks(next, remaining, attempt, options), {
    signal: options.signal,
    shouldFallback: options.shouldFallback,
    onFallback: () => options.onFallback(source, next),
  });
}
