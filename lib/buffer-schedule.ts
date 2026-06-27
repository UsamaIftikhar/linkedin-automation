/**
 * When not posting immediately, default queue time is now + N minutes (default 5).
 * Override exact time with BUFFER_SCHEDULED_DUE_AT (ISO 8601), which wins over offset
 * — but only if it is still safely in the future. A stale override gets ignored.
 */
export function queueDueAtIso(): string {
  const fromEnv = process.env.BUFFER_SCHEDULED_DUE_AT?.trim();
  if (fromEnv) {
    const t = Date.parse(fromEnv);
    // Honor the override only when it is at least 60s in the future. Buffer rejects
    // dueAt values that have already passed on their server clock.
    if (Number.isFinite(t) && t > Date.now() + 60_000) {
      return fromEnv;
    }
  }
  const raw = process.env.BUFFER_SCHEDULE_OFFSET_MINUTES?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : 5;
  // Floor at 2 minutes — anything less risks clock skew between Vercel and Buffer.
  const minutes = Number.isFinite(parsed) && parsed >= 2 ? parsed : 5;
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

/**
 * "Post now" via Buffer GraphQL still requires a dueAt that is STRICTLY in the
 * future on Buffer's server clock. A bare `new Date().toISOString()` reliably
 * loses to clock skew + network latency and is rejected with
 * "Invalid post input: dueAt must be in the future".
 *
 * Add a small offset (default 60s, configurable via BUFFER_POST_NOW_OFFSET_SECONDS)
 * so Buffer always sees the timestamp as future-tense. Buffer treats this as
 * "post immediately" anyway because the offset is well under their queue floor.
 */
export function immediateDueAtIso(): string {
  const raw = process.env.BUFFER_POST_NOW_OFFSET_SECONDS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  const seconds = Number.isFinite(parsed) && parsed >= 30 ? parsed : 60;
  return new Date(Date.now() + seconds * 1000).toISOString();
}
