import type { PostType } from "@/lib/post-types";
import type { PipelineLogger } from "@/lib/pipeline-log";

// deepseek-chat is a legacy alias that retires 2026-07-24 and routes to
// deepseek-v4-flash non-thinking mode anyway. Set the default to the
// canonical current model so deployments that forget to set DEEPSEEK_MODEL
// don't break on the deprecation date.
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
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
- Project references are OPTIONAL and must never be forced. Only mention a project (Cova, WattVue, EverCare, Jarvis, the ATS/CV Analyzer, the Upwork proposal tool, the RAG app, Carletz, etc.) if it is the most credible way to make the point. If the draft angle has no project, keep it project-free.
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
  // Tight cap intentionally: a well-formed post is ~330 tokens (130 prose words +
  // hashtags + structure markers). Larger budgets correlate with tail collapse
  // in Flash-class models — the model fills the space with degraded tokens
  // instead of stopping. 900 leaves ~3x headroom but doesn't invite rambling.
  // Reasoner spends additional budget on internal reasoning_content.
  return model === "deepseek-reasoner" ? 8000 : 900;
}

type DeepSeekResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: number | string;
    status?: string;
    type?: string;
  };
};

const SYSTEM_PROMPT = `
CRITICAL INSTRUCTION: Output only the final LinkedIn post. No preamble, no explanation, no reasoning, no meta-commentary, no "Here is the post:" prefix. Start directly with the hook line. End with the hashtag line. Nothing before, nothing after.

You write LinkedIn posts for Usama Iftikhar, a Senior Full-Stack AI Developer from Pakistan who builds AI-powered SaaS products for founders and CTOs.

TARGET AUDIENCE:
Startup founders, CTOs, product owners, and technical hiring managers.
NOT other developers. Write so a non-technical founder understands the stakes and a technical CTO respects the depth.

USAMA'S REAL PROJECTS (optional — reference ONLY when it genuinely strengthens the point; most posts should NOT name a project):
- Cova: voice AI assistant for insurance brokers, live on App Store (DeepSeek transcription + ElevenLabs TTS + Claude reasoning, React Native, WebSockets) — apps.apple.com/us/app/cova/id6748680152
- WattVue: solar energy SaaS (CRM portal + real-time dashboard for 200+ IoT device arrays + mobile app, WattDetect computer-vision panel detection), live in the US — wattvue.com
- EverCare: healthcare caregiver platform serving 10,000+ users (Vue/Nuxt, Node, MySQL, AWS EC2; matchmaking, scheduling, billing)
- AI ATS & CV Analyzer: async pipeline scoring 1,000 resumes in under 10 minutes (FastAPI + Celery + Redis + OpenAI + GitHub API + Postgres)
- Jarvis: voice-first personal AI assistant with a full ReAct agent loop and sub-300ms response (faster-whisper STT, DeepSeek V3, ElevenLabs, ChromaDB vector memory, MCP tools for Gmail/Calendar, Capacitor + Swift iOS)
- Upwork Proposal Intelligence: agentic tool that fetches jobs every 20 min, scores fit, and generates tailored proposals (NestJS, DeepSeek V4 Flash, Prisma, Postgres) with zero silent failures in production
- RAG knowledge base: domain-tuned retrieval with semantic chunking + hallucination mitigation (Mistral + Django REST + React)
- Carletz: automotive sales platform with Stripe billing webhooks, AWS S3 media, 85%+ test coverage (NestJS, Next.js, Heroku CI/CD)
- 26 client contracts across 4 continents, 100% client satisfaction / Job Success Score

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
4. Project references are OPTIONAL. Only name a specific project when it is the most credible way to make the exact point — and never name one just to name one. Many of the strongest posts are pure insight, an industry observation, or hiring/founder advice with NO project mentioned. If the pillar draft below does not include a project, do not invent or force one.
5. Never explain jargon with more jargon — if you use a technical term, follow it with a plain explanation in parentheses or a short clause
6. The first line must never start with "I"
7. No dense paragraphs — maximum 2 sentences per paragraph
`.trim();

function resolveDeepSeekTimeoutMs(): number {
  const raw = process.env.DEEPSEEK_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 5_000) {
    return Math.min(parsed, 55_000);
  }
  return 25_000;
}

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
  signal?: AbortSignal;
  /** When set, logs prompt → request → raw response → parsed content for this call. */
  pipelineLog?: PipelineLogger;
  attempt?: number;
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
    signal,
    pipelineLog,
    attempt = 1,
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

OUTPUT THIS EXACT STRUCTURE. Each section is mandatory:

HOOK (1 line, max 16 words):
One punchy statement or question that makes a founder/CTO stop scrolling.
Must NOT start with "I".
No hashtags. No emojis. No markdown.

STORY (2 paragraphs, max 3 sentences each, blank line between paragraphs):
Concrete technical situation with named tools (Postgres, AWS Lambda, DeepSeek, Stripe, etc.).
Each sentence max 25 words.
Each sentence must be grammatically complete and make sense in isolation.
Never trail off mid-idea. If a sentence isn't coherent, rewrite it before continuing.

TAKEAWAY (1-2 sentences):
The clear lesson a founder or CTO should walk away with. Connects directly to the story.

QUESTION (1 line, ends with "?"):
One direct question to the reader. Must relate to the post topic.

HASHTAGS (final line ONLY):
5-7 space-separated hashtags on a single dedicated final line.
Format: #Tag1 #Tag2 #Tag3 — include at least 2 audience hashtags (#SaaS, #Startups, #TechLeadership, #ProductDevelopment, #CTOs, #AITools) and at least 2 technical hashtags.
No hashtags ANYWHERE else in the post.

GLOBAL RULES (non-negotiable):
- Total prose: 110–150 words (lint caps at 220 — staying near 130 is safest).
- NO MARKDOWN: no **bold**, no *italic*, no \`code\`, no --- separators, no [links](...).
- NO INVENTED WORDS: never output pseudo-technical neologisms ("re-calks", "loire side potential", "oversacificing"). If you don't know the precise term, use a plain-English description.
- NO TAIL COLLAPSE: every sentence must be one a senior engineer would say out loud to a CTO. Before emitting the next sentence, read the previous one back to yourself. If it doesn't make complete grammatical sense, REWRITE IT.
- NEVER trail off. NEVER skip the hashtag line. If you're running long, drop sentences from the middle — keep the structure intact.
- SELF-CHECK before submitting: scan your output. If ANY sentence is incoherent, rewrite the post from scratch. Do not submit a post with broken sentences under any circumstances.

${validatorChecklist}
${revisionNotes ? `\nREVISION NOTES (this is a retry — fix exactly these issues, do NOT introduce new ones):\n${revisionNotes}\n\nWhen retrying:\n- Keep the hook if it was good.\n- Keep the structure intact.\n- Rewrite any paragraph that contains broken or incoherent sentences.\n- Do not invent new ideas. Fix what is broken.` : ""}`;

  pipelineLog?.step("deepseek.prompt_built", {
    attempt,
    isRetry: Boolean(revisionNotes),
    model,
    postType,
    systemPromptChars: SYSTEM_PROMPT.length,
    userPromptChars: userPrompt.length,
    draftInPromptChars: draft.length,
    hasRevisionNotes: Boolean(revisionNotes),
    revisionNotesPreview: revisionNotes?.slice(0, 300),
    userPromptTail: userPrompt.slice(-400),
  });
  pipelineLog?.snapshot("deepseek.draft_input", draft, "draft_sent_in_user_prompt", {
    attempt,
    draftSource: "pillar_template",
  });

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

  // DeepSeek V4 models (e.g. deepseek-v4-flash / deepseek-v4-pro) default to thinking mode ON,
  // which spends the output-token budget on hidden reasoning_content (which we don't read) and
  // starves the actual post — causing truncated or stub output. Enable thinking only for the
  // dedicated reasoner model; explicitly disable it for everything else so generation is fast,
  // cheap, and reliably produces the final post within max_tokens.
  requestBody.thinking = isReasoningModel
    ? { type: "enabled" }
    : { type: "disabled" };

  // DeepSeek thinking mode ignores temperature; only send it for non-reasoning models.
  if (!isReasoningModel && typeof temperature === "number") {
    requestBody.temperature = temperature;
  }

  pipelineLog?.step("deepseek.request_send", {
    attempt,
    endpoint,
    model,
    max_tokens: requestBody.max_tokens,
    temperature: requestBody.temperature ?? null,
    thinking: requestBody.thinking,
    stream: requestBody.stream,
    timeoutMs: resolveDeepSeekTimeoutMs(),
    messageCount: (requestBody.messages as unknown[]).length,
  });

  // Hard per-call timeout. Vercel kills the function at 60s on Hobby, so a
  // hung DeepSeek connection MUST not block us past our wall-clock budget.
  // Caller may also pass a shorter `signal` derived from the remaining run budget.
  const perCallTimeout = AbortSignal.timeout(resolveDeepSeekTimeoutMs());
  const combinedSignal = signal
    ? AbortSignal.any([signal, perCallTimeout])
    : perCallTimeout;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: combinedSignal,
    });
  } catch (e) {
    const err = e as Error & { name?: string };
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      throw new Error(
        `DeepSeek (${model}) timed out after ${resolveDeepSeekTimeoutMs()}ms. Lower DEEPSEEK_TIMEOUT_MS or check api.deepseek.com status.`,
      );
    }
    throw e;
  }

  // Read as text first so we can surface the actual body when JSON parsing fails.
  const rawBody = await res.text();

  pipelineLog?.step("deepseek.response_http", {
    attempt,
    httpStatus: res.status,
    contentType: res.headers.get("content-type"),
    rawBodyChars: rawBody.length,
    rawBodyHead: rawBody.slice(0, 120),
  });

  let data: DeepSeekResponse;
  try {
    data = JSON.parse(rawBody) as DeepSeekResponse;
  } catch {
    const ct = res.headers.get("content-type") ?? "unknown";
    const snippet = rawBody.slice(0, 240).replace(/\s+/g, " ").trim();
    throw new Error(
      `DeepSeek returned non-JSON (HTTP ${res.status}, content-type=${ct}). Body snippet: "${snippet || "<empty>"}". Likely an HTML error/maintenance page or an unknown model name — try DEEPSEEK_MODEL=deepseek-chat.`,
    );
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
  const rawContent = message?.content ?? "";
  const reasoningContent = message?.reasoning_content ?? "";
  const text = rawContent.trim();
  const finishReason = data.choices?.[0]?.finish_reason;

  pipelineLog?.step("deepseek.response_parsed", {
    attempt,
    finishReason: finishReason ?? null,
    usage: (data as { usage?: unknown }).usage ?? null,
    rawContentChars: rawContent.length,
    reasoningContentChars: reasoningContent.length,
    trimmedContentChars: text.length,
    hasReasoningContent: reasoningContent.length > 0,
  });
  pipelineLog?.snapshot("deepseek.model_output_raw", rawContent, "api_message.content_before_trim", {
    attempt,
    finishReason: finishReason ?? null,
  });
  if (reasoningContent.length > 0) {
    pipelineLog?.snapshot(
      "deepseek.reasoning_content",
      reasoningContent,
      "api_message.reasoning_content_not_used",
      { attempt },
    );
  }

  if (!text) {
    throw new Error(
      finishReason === "length"
        ? `DeepSeek (${model}) ran out of output tokens before producing the final post (max_tokens=${resolveMaxTokens(model)}). Lower DEEPSEEK_TEMPERATURE so it stops rambling, or raise DEEPSEEK_MAX_TOKENS.`
        : finishReason
          ? `DeepSeek returned no final text (finish_reason=${finishReason})`
          : "DeepSeek returned empty text",
    );
  }

  // Truncated output is never useful: hashtags / closing question are always
  // emitted last, so a `length` cutoff means the post is incomplete. Throw so
  // the retry loop runs again with revision notes instead of accepting garbage.
  if (finishReason === "length") {
    const endsWithHashtags = /#\w+\s*$/.test(text);
    if (!endsWithHashtags) {
      throw new Error(
        `DeepSeek (${model}) hit max_tokens (${resolveMaxTokens(model)}) before emitting hashtags. Raise DEEPSEEK_MAX_TOKENS or tighten the prompt.`,
      );
    }
  }

  pipelineLog?.snapshot("deepseek.model_output_final", text, "returned_to_pipeline", {
    attempt,
    finishReason: finishReason ?? null,
  });

  return text;
}
