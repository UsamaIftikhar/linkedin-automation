import { verifyCronSecret } from "@/lib/cron-auth";
import { runLinkedInAutomation } from "@/lib/run-linkedin-automation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!verifyCronSecret(request, cronSecret)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const postNow = process.env.BUFFER_POST_NOW === "true";
  return runLinkedInAutomation(postNow);
}

export async function POST(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!verifyCronSecret(request, cronSecret)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const postNow = process.env.BUFFER_POST_NOW === "true";
  return runLinkedInAutomation(postNow);
}
