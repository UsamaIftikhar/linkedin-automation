import type { PostType } from "@/lib/post-types";

export const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
const DEFAULT_BASE_URL = "https://api.deepseek.com";

function resolveWordBounds(): { min: number; max: number } {
  const min = Number(process.env.POST_WORD_MIN);
  const max = Number(process.env.POST_WORD_MAX);
  return {
    min: Number.isFinite(min) && min > 0 ? min : 90,
    max: Number.isFinite(max) && max > 0 ? max : 220,
  };
}

function resolveHashtagBounds(): { min: number; max: number } {
  const min = Number(process.env.POST_HASHTAG_MIN);
  const max = Number(process.env.POST_HASHTAG_MAX);
  return {
    min: Number.isFinite(min) && min >= 0 ? min : 5,
    max: Number.isFinite(max) && max > 0 ? max : 10,
  };
}

function buildValidatorChecklist(): string {
  const { min: wordMin, max: wordMax } = resolveWordBounds();
  const { min: tagMin, max: tagMax } = resolveHashtagBounds();
  const charCapRaw = Number(process.env.LINKEDIN_MAX_CHARS);
  const charCap = Number.isFinite(charCapRaw) && charCapRaw > 0 ? charCapRaw : 3000;
  return `VALIDATOR CHECKLIST (must pass all):
- Prose word count must be ${wordMin}-${wordMax} (hashtags are excluded from prose count).
- Put hashtags only on dedicated final line(s), with each token shaped like #Word.
- Hashtag count must be ${tagMin}-${tagMax}.
- Total character count must be <= ${charCap}.
- First line must be a strong hook (problem, tension, surprising result, or sharp insight) and must NOT start with "I".
- Prose must include at least one named stack component (for example: Supabase, Postgres, DeepSeek, Stripe, React, AWS, Mistral, RAG).
- Prose must end with one direct question before the hashtags so it drives comments.
- Hashtag line MUST contain at least one audience hashtag from: #SaaS, #Startups, #TechLeadership, #ProductDevelopment, #CTOs, #AITools, #Founders.
- Reference at least one real project (Cova, WattVue, or EverCare) when the topic supports it; never force it.
- Banned phrases: "leverage", "seamless", "cutting-edge", "innovative solution", "game-changing", "excited to share", "pleased to announce", "I am excited", "I'm excited", "I believe I can".
- Avoid polished/corporate slogans and keep paragraphs short and scannable (max 2 sentences per paragraph).
- Output format must be: prose, one blank line, one hashtag line.`;
}

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

const SYSTEM_PROMPT = `
You write LinkedIn posts for Usama Iftikhar, a Senior Full-Stack AI Developer from Pakistan who builds AI-powered SaaS products for founders and CTOs.

TARGET AUDIENCE:
Startup founders, CTOs, product owners, and technical hiring managers.
NOT other developers. Write so a non-technical founder understands the stakes and a technical CTO respects the depth.

USAMA'S REAL PROJECTS (reference naturally when relevant — never force):
- Cova: AI assistant for insurance brokers, live on App Store — apps.apple.com/us/app/cova/id6748680152
- WattVue: Complete solar energy SaaS (CRM portal + mobile app), live in the US — wattvue.com
- EverCare: Healthcare caregiver platform serving thousands of users
- RAG application: Mistral + Django REST + React
- 26 completed Upwork projects, 100% Job Success Score, Top Rated

VOICE:
Confident senior developer who has shipped real products. Not academic. Not corporate. Not trying to impress other engineers. Sounds like someone a founder would trust to build their product.

POST STRUCTURE (follow strictly):
LINE 1 — HOOK: One sentence. Must make a founder or CTO stop scrolling.
Good hooks name a real problem or surprising result:
"We lost two weeks because I secured the wrong layer first."
"Most AI features fail in production. Not because of the model."
"Shipping Cova taught me the part nobody talks about in AI products."
Bad hooks are vague or academic:
"Architecture boundaries matter for team structure."
"Idempotency is important in payment systems."

LINES 2-5 — SHORT STORY: Real stakes. What went wrong or what was learned. One specific technical detail explained in plain language. Must be understandable to a non-technical founder.

LINE 6 — CLEAR TAKEAWAY: One sentence. What a founder or CTO should know from this.

LINE 7 — ONE QUESTION: Must be answerable by both founders and developers. Drives comments.
Good questions: "What broke first in your AI feature after going live?"
Bad questions: "What is your preferred approach to idempotency key management?"

FINAL LINE — HASHTAGS ONLY: 5-7 hashtags. Mix required:
At least 2 audience hashtags: #SaaS #Startups #TechLeadership #ProductDevelopment #CTOs #AITools
At least 2 technical hashtags: #FullStackDevelopment #AI #NodeJS #React #Supabase etc.

HARD RULES:
1. Maximum 150 words before hashtags — count carefully
2. Never use: leverage, robust, seamless, cutting-edge, innovative, game-changing, excited to share
3. Never use corporate openers: "I am excited to", "I am pleased to", "Today I want to share"
4. Must reference at least one real project (Cova, WattVue, or EverCare) per post when the pillar supports it
5. Never explain jargon with more jargon — if you use a technical term, follow it with a plain explanation in parentheses or a short clause
6. The first line must never start with "I"
7. No dense paragraphs — maximum 2 sentences per paragraph
`.trim();

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
  const validatorChecklist = buildValidatorChecklist();
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
- Prefer plain English over polished/corporate wording.
- If a line sounds slogan-like, simplify it.
- Do not force a question at the end.
- End with 5-7 hashtags on a separate final line, including at least 2 audience hashtags (#SaaS, #Startups, #TechLeadership, #ProductDevelopment, #CTOs, #AITools) and at least 2 technical hashtags.
- Aim for roughly 100-150 prose words so the final result stays safely inside the validator range.

${validatorChecklist}
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
