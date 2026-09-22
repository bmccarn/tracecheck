/**
 * A signal that aborts after `ms` with an error carrying `message`, so callers can tell which limit
 * fired and how long it was. Like AbortSignal.timeout, the timer does not keep the process alive.
 */
export function deadline(ms: number, message: string): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error(message)), ms).unref();
  return controller.signal;
}
