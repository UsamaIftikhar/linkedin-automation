import type { PostType } from "@/lib/post-types";

export const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
const DEFAULT_BASE_URL = "https://api.deepseek.com";

function resolveMaxTokens(model: string): number {
  const raw = process.env.DEEPSEEK_MAX_TOKENS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  // Reasoner spends output budget on reasoning_content too.
  // Chat-only generation can use a much tighter cap.
  return model === "deepseek-reasoner" ? 8000 : 1500;
}

type DeepSeekResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  error?: {
    message?: string;
    code?: number | string;
    status?: string;
    type?: string;
  };
};

const SYSTEM_PROMPT = `You are a professional LinkedIn ghostwriter for a senior software engineer with expertise in:

- Backend development (APIs, PostgreSQL, Supabase, authentication, event-driven systems)
- Cloud infrastructure (AWS EC2, Lambda, VPC, scaling systems)
- DevOps (CI/CD pipelines, deployments, monitoring, logging)
- IoT systems (AWS IoT Core, MQTT, telemetry pipelines)
- Frontend development (Next.js, React, TypeScript, performance, rendering)
- Platform deployments (DigitalOcean, Railway, Vercel, managed infra tradeoffs)
- AI model operations (Ollama, Mistral, DeepSeek, NVIDIA NIM, inference workflows)
- Automation flows (Python functions, cron-job.org, scheduled jobs, external triggers)
- Low-code integrations
- AI/ML integrations (RAG, APIs, prompt engineering)

Your job is to write ONE high-quality LinkedIn post.

CONTENT REQUIREMENTS:
1. Length: 110-220 words of prose only. Do not count hashtags toward this range.
   Target 130-190 prose words.
   Use the full range naturally when the format needs bullets or short section labels.
2. First-person perspective ("I").
3. Must include at least TWO named technical elements in the prose, not just hashtags. Good examples:
   - AWS IoT Core rule -> Kinesis -> Lambda
   - idempotent writes keyed in DynamoDB or Postgres
   - GitHub Actions required check on main before ECS deploy
   - CloudWatch alarm on consumer lag
4. Do not use vague-only phrasing like "ingest workers", "the pipeline", or "telemetry layer" unless you also name the actual service or component.
5. No fake metrics, clients, or exaggerated claims.
6. No emojis.
7. Avoid generic phrases like "game changer", "leverage synergy", "in today's fast-paced world", "unlock", "delve", "robust", "cutting-edge", and "here's the thing".
8. Tone: professional, technical, practical, direct.

VOICE AND POSITIONING:
- Write like a senior engineer who builds and operates real systems, not a consultant selling process.
- Sound credible, grounded, and human-written.
- Prioritize implementation details, failure modes, tradeoffs, operational lessons, and decision-making under constraints.
- It is fine to sound explanatory or reflective when the topic fits. Not every post has to read like a dramatic case study.
- Teach clearly. Simplicity is good if the engineering depth stays real.
- Do not always end with a question or a CTA. A sharp takeaway is often better.

FORMAT AND POST DESIGN:
- The post should be visually scannable in the LinkedIn feed.
- Use multiple short paragraphs by default, not one dense block.
- You MAY use short section labels such as "Architecture overview", "What changed", "Why this worked", or "Key takeaway" when they help.
- You MAY use 2-4 short hyphen bullets when listing components, mistakes, or takeaways.
- Do not over-format. Use sections or bullets only when they improve clarity.
- Do not use markdown numbering, code fences, or decorative formatting.

STRUCTURE OPTIONS:
- Implementation story: problem -> system/design choice -> tradeoff -> takeaway
- Technical explainer: simple framing -> where it fits -> where it breaks -> takeaway
- Engineering judgment: strong insight -> reasoning -> practical conclusion
- Architecture breakdown: short intro -> labeled sections -> concise closing

HASHTAG RULES:
- Mandatory: after the prose, output one blank line, then ONE line of 5-10 space-separated hashtags.
- Use only hashtag words like #AWS or #CloudArchitecture. No slashes.
- Mix broad + niche tags.
- Do not place hashtags inside the prose.

POSITIONING:
- Anchor every post in technical reality: AWS, DigitalOcean, Railway, Vercel, APIs, PostgreSQL, CI/CD, Bitbucket Pipelines, Docker/Kubernetes, MQTT, telemetry, monitoring, scaling, frontend architecture, model serving, failure modes.
- Do not center procurement, SOWs, clients, sales cycles, decks, or commercial discovery.
- If the draft sounds business-generic, rewrite it into a technical implementation story with the same tension but an engineering lens.

OUTPUT:
- Return only the final post.
- Format: post body, blank line, hashtag line.
- No title, no markdown fences, no commentary.
- Before answering, check that the prose is between 110 and 220 words.`;

export async function polishWithDeepSeek(options: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  draft: string;
  domainFocus: string;
  postType: PostType;
  postTypeGuidance: string;
  formatGuidance: string;
  revisionNotes?: string;
}): Promise<string> {
  const {
    apiKey,
    model = DEFAULT_DEEPSEEK_MODEL,
    baseUrl = DEFAULT_BASE_URL,
    temperature,
    draft,
    domainFocus,
    postType,
    postTypeGuidance,
    formatGuidance,
    revisionNotes,
  } = options;

  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const userPrompt = `POST TYPE: ${postType}

Write the post according to this type:
${postTypeGuidance}

LAYOUT DIRECTION:
${formatGuidance}

DOMAIN FOCUS:
${domainFocus}

DRAFT ANGLE (rewrite freely, keep only the useful technical direction):
---
${draft}
---

Reminder:
- Make the post feel human-written and technically credible.
- Match this author's style: practical, scannable, sometimes explanatory, sometimes reflective, always grounded in real engineering work.
- Include specific implementation details and tradeoffs.
- Prefer short paragraphs. Use section labels or hyphen bullets only when they improve readability.
- Do not force a question at the end.
- End with 5-10 hashtags on a separate final line.
- Aim for roughly 130-190 prose words so the final result stays safely inside the validator range.
${revisionNotes ? `\nREVISION NOTES:\n${revisionNotes}` : ""}`;

  const isReasoningModel = model === "deepseek-reasoner";
  const requestBody: Record<string, unknown> = {
    model,
    stream: false,
    max_tokens: resolveMaxTokens(model),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  };

  // Only enable reasoning for the dedicated reasoner model.
  if (isReasoningModel) {
    requestBody.thinking = { type: "enabled" };
  }

  // DeepSeek thinking mode ignores temperature; only send it for non-reasoning models.
  if (!isReasoningModel && typeof temperature === "number") {
    requestBody.temperature = temperature;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  let data: DeepSeekResponse;
  try {
    data = (await res.json()) as DeepSeekResponse;
  } catch {
    throw new Error(`DeepSeek returned non-JSON (HTTP ${res.status})`);
  }

  if (!res.ok) {
    const detail =
      data.error?.message ??
      (typeof data.error === "object" && data.error
        ? JSON.stringify(data.error)
        : `DeepSeek HTTP ${res.status}`);
    throw new Error(detail);
  }

  const message = data.choices?.[0]?.message;
  const text = message?.content?.trim();
  if (!text) {
    const finishReason = data.choices?.[0]?.finish_reason;
    throw new Error(
      finishReason === "length"
        ? "DeepSeek ran out of output tokens before producing the final post. Increase DEEPSEEK_MAX_TOKENS for deepseek-reasoner."
        : finishReason
          ? `DeepSeek returned no final text (finish_reason=${finishReason})`
          : "DeepSeek returned empty text",
    );
  }

  return text;
}
