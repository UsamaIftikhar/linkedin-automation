/**
 * When not posting immediately, default queue time is now + N minutes (default 5).
 * Override exact time with BUFFER_SCHEDULED_DUE_AT (ISO 8601), which wins over offset.
 */
export function queueDueAtIso(): string {
  const fromEnv = process.env.BUFFER_SCHEDULED_DUE_AT?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const raw = process.env.BUFFER_SCHEDULE_OFFSET_MINUTES?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : 5;
  const minutes = Number.isFinite(parsed) && parsed >= 1 ? parsed : 5;
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export function immediateDueAtIso(): string {
  return new Date().toISOString();
}
