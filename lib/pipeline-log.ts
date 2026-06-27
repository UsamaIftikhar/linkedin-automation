import { createHash } from "node:crypto";

export type PipelineTraceEntry = {
  step: string;
  ts: string;
  [key: string]: unknown;
};

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Short stable fingerprint so you can compare “same text?” across steps in logs. */
export function textFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** Safe snapshot for logs / API trace — never includes secrets. */
export function textSnapshot(text: string, label: string): Record<string, unknown> {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const snap: Record<string, unknown> = {
    label,
    chars: text.length,
    words: countWords(text),
    lines: lines.length,
    fingerprint: textFingerprint(text),
    firstLine: lines[0]?.slice(0, 160) ?? "",
    lastLine: lines[lines.length - 1]?.slice(0, 160) ?? "",
    head: text.slice(0, 200),
    tail: text.slice(-200),
  };
  if (process.env.PIPELINE_LOG_FULL === "true") {
    snap.full = text;
  }
  return snap;
}

/**
 * Collects ordered pipeline steps for Vercel logs and optional API responses.
 * Enable verbose body logging with PIPELINE_LOG_FULL=true.
 * Include trace in JSON responses with PIPELINE_TRACE_IN_RESPONSE=true (or on 422/dry_run).
 */
export class PipelineLogger {
  readonly runId: string;
  readonly trace: PipelineTraceEntry[] = [];

  constructor(runId: string) {
    this.runId = runId;
  }

  step(step: string, data: Record<string, unknown> = {}): void {
    const entry: PipelineTraceEntry = {
      step,
      ts: new Date().toISOString(),
      ...data,
    };
    this.trace.push(entry);
    console.log(
      "[pipeline]",
      JSON.stringify({ event: "pipeline_step", runId: this.runId, ...entry }),
    );
  }

  snapshot(step: string, text: string, label: string, extra: Record<string, unknown> = {}): void {
    this.step(step, { ...textSnapshot(text, label), ...extra });
  }

  shouldIncludeInResponse(): boolean {
    // Always include trace on skip/failure responses and dry runs (auth-gated endpoint).
    return true;
  }
}
