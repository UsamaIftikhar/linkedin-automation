import { verifyCronSecret } from "@/lib/cron-auth";
import { runLinkedInAutomation } from "@/lib/run-linkedin-automation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function parseNowFlag(value: string | null | undefined): boolean | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "now"].includes(v)) {
    return true;
  }
  if (["0", "false", "no", "queue"].includes(v)) {
    return false;
  }
  return undefined;
}

async function resolvePostNow(request: Request): Promise<boolean> {
  const url = new URL(request.url);
  const q = parseNowFlag(url.searchParams.get("now"));
  if (q !== undefined) {
    return q;
  }

  if (request.method === "POST") {
    const ct = request.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        const body = (await request.json()) as { now?: unknown };
        if (typeof body.now === "boolean") {
          return body.now;
        }
        if (typeof body.now === "string") {
          const p = parseNowFlag(body.now);
          if (p !== undefined) {
            return p;
          }
        }
      } catch {
        /* ignore invalid JSON */
      }
    }
  }

  return process.env.BUFFER_POST_NOW === "true";
}

function verifyPostSecret(request: Request): boolean {
  const secret = process.env.POST_API_SECRET?.trim();
  if (!secret || secret.length < 16) {
    return true;
  }
  return verifyCronSecret(request, secret);
}

export async function GET(request: Request) {
  if (!verifyPostSecret(request)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const postNow = await resolvePostNow(request);
  return runLinkedInAutomation(postNow);
}

export async function POST(request: Request) {
  if (!verifyPostSecret(request)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const postNow = await resolvePostNow(request);
  return runLinkedInAutomation(postNow);
}
