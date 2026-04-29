import { verifyCronSecret } from "@/lib/cron-auth";
import { runLinkedInAutomation } from "@/lib/run-linkedin-automation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily cron schedule: 07:00 UTC, Monday–Friday only
 * (12:00 PM PKT / 03:00 AM EST — catches US morning scroll).
 *
 * Vercel cron is configured in `vercel.json`. We also enforce the weekday rule
 * here so external triggers (cron-job.org, etc.) skip Saturday and Sunday.
 */
function isWeekendUtc(now: Date): boolean {
  const day = now.getUTCDay();
  return day === 0 || day === 6;
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!verifyCronSecret(request, cronSecret)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (isWeekendUtc(new Date()) && process.env.CRON_ALLOW_WEEKENDS !== "true") {
    return Response.json({
      ok: true,
      skipped: true,
      reason: "weekend_skip",
    });
  }
  const postNow = process.env.BUFFER_POST_NOW === "true";
  return runLinkedInAutomation(postNow);
}

export async function POST(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!verifyCronSecret(request, cronSecret)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (isWeekendUtc(new Date()) && process.env.CRON_ALLOW_WEEKENDS !== "true") {
    return Response.json({
      ok: true,
      skipped: true,
      reason: "weekend_skip",
    });
  }
  const postNow = process.env.BUFFER_POST_NOW === "true";
  return runLinkedInAutomation(postNow);
}
