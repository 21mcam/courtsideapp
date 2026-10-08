// In-memory failed-login throttle for the platform console.
//
// One Express process serves everything (CLAUDE.md), so process memory
// is the right size for this: a restart resets the counters, which
// only ever helps the legitimate operator. Keyed twice — per IP and per
// email — so neither a spray across emails from one IP nor a
// distributed guess at one email gets more than MAX_FAILURES tries per
// window. Successful login clears both keys.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

export function createLoginThrottle({ windowMs = WINDOW_MS, maxFailures = MAX_FAILURES } = {}) {
  const failures = new Map(); // key -> { count, resetAt }

  function entry(key, now) {
    const e = failures.get(key);
    if (!e || e.resetAt <= now) return null;
    return e;
  }

  return {
    // Seconds until the caller may retry, or 0 if not blocked.
    blockedFor(keys, now = Date.now()) {
      let wait = 0;
      for (const key of keys) {
        const e = entry(key, now);
        if (e && e.count >= maxFailures) {
          wait = Math.max(wait, Math.ceil((e.resetAt - now) / 1000));
        }
      }
      return wait;
    },
    recordFailure(keys, now = Date.now()) {
      for (const key of keys) {
        const e = entry(key, now);
        if (e) e.count += 1;
        else failures.set(key, { count: 1, resetAt: now + windowMs });
      }
      // Opportunistic sweep so the map can't grow without bound.
      if (failures.size > 10_000) {
        for (const [k, e] of failures) if (e.resetAt <= now) failures.delete(k);
      }
    },
    clear(keys) {
      for (const key of keys) failures.delete(key);
    },
  };
}
