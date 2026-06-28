export type ReviewResult = {
  coherent: boolean;
  readable: boolean;
  professional: boolean;
  issues: string[];
  /** Reviewer could not run (missing key, API/parse error) — not a content rejection. */
  unavailable?: boolean;
};

export function reviewerConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export function isReviewerUnavailable(review: ReviewResult): boolean {
  return review.unavailable === true;
}

const REVIEWER_SYSTEM_PROMPT = `You are a strict quality reviewer for LinkedIn posts. You will receive a post draft. Read EVERY sentence carefully and judge whether it actually means something a human wrote intentionally.

Respond with ONLY valid JSON, no markdown, no preamble:
{
  "coherent": boolean,
  "readable": boolean,
  "professional": boolean,
  "issues": ["specific problems found"]
}

Set "coherent": false if ANY sentence is word-salad, grammatically broken, trails off, or does not parse as a real English sentence. Examples of incoherent text that MUST score coherent:false — "none is alive beside view to always reading load count", "automated stops securely progress into make monitoring growth faster". Set "professional": false if publishing this would embarrass a senior engineer. Be strict — when in doubt, fail it.`;

function parseReviewJson(raw: string): ReviewResult | null {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as {
      coherent?: boolean;
      readable?: boolean;
      professional?: boolean;
      issues?: unknown;
    };
    return {
      coherent: parsed.coherent === true,
      readable: parsed.readable === true,
      professional: parsed.professional === true,
      issues: Array.isArray(parsed.issues)
        ? parsed.issues.filter((i): i is string => typeof i === "string")
        : [],
    };
  } catch {
    return null;
  }
}

function failClosed(reason: string): ReviewResult {
  return {
    coherent: false,
    readable: false,
    professional: false,
    issues: [reason],
    unavailable: true,
  };
}

/**
 * Semantic quality gate via Anthropic Claude — separate provider from DeepSeek
 * generation so a bad generation day cannot corrupt both writer and reviewer.
 */
export async function reviewPostCoherence(options: {
  postText: string;
  signal?: AbortSignal;
}): Promise<ReviewResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return failClosed("ANTHROPIC_API_KEY not set — failing closed");
  }

  const model =
    process.env.ANTHROPIC_REVIEWER_MODEL?.trim() || "claude-3-5-haiku-20241022";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      system: REVIEWER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: options.postText }],
    }),
    signal: options.signal,
  });

  let data: {
    content?: Array<{ type?: string; text?: string }>;
    error?: { message?: string };
  };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return failClosed("reviewer returned non-JSON response — failing closed");
  }

  if (!res.ok) {
    const msg = data.error?.message ?? `Anthropic HTTP ${res.status}`;
    return failClosed(`reviewer API error: ${msg}`);
  }

  const raw = data.content?.find((b) => b.type === "text")?.text?.trim() ?? "";
  const parsed = parseReviewJson(raw);
  if (!parsed) {
    return failClosed("reviewer returned unparseable JSON — failing closed");
  }
  return { ...parsed, unavailable: false };
}
