import { randomUUID } from "crypto";

import { bufferCreatePostGraphql } from "@/lib/buffer-graphql";
import { queueDueAtIso } from "@/lib/buffer-schedule";
import { buildDraftPost, lintBannedPhrases } from "@/lib/content";
import {
  createIdeaViaGraphql,
  titleFromPostBody,
} from "@/lib/ideas-graphql";
import {
  DEFAULT_DEEPSEEK_MODEL,
  polishWithDeepSeek,
} from "@/lib/deepseek";
import {
  countWords,
  domainFocusForPrompt,
  extractHashtags,
  hasStrongHook,
  lintLinkedInPost,
  pickDomainFocusForRun,
  splitProseAndHashtagBlock,
  type DomainFocusSlug,
  type PostLintResult,
} from "@/lib/linkedin-post-rules";
import { appendPostMemory, loadPostMemory } from "@/lib/post-memory";
import {
  pickPostType,
  postTypeGuidance,
  type PostType,
} from "@/lib/post-types";

/** Buffer rejects identical copy sent twice in a short window; enable for local testing. */
function applyOptionalPostNonce(body: string): string {
  if (process.env.APPEND_POST_NONCE !== "true") {
    return body;
  }
  return `${body.trimEnd()}\n\n— ${new Date().toISOString()}`;
}

function isBufferDuplicatePostError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("posted that one recently") ||
    m.includes("same thing again") ||
    m.includes("duplicate")
  );
}

/** Dev-only: allow pillar template + Buffer without DeepSeek (adds placeholder hashtags in draft). */
function allowTemplatePublish(): boolean {
  return process.env.ALLOW_TEMPLATE_PUBLISH === "true";
}

function resolveLlmTemperature(model: string): number | undefined {
  const raw =
    process.env.DEEPSEEK_TEMPERATURE?.trim() ??
    process.env.LLM_TEMPERATURE?.trim();
  if (!raw) {
    // Creative writing default. DeepSeek ignores this for `deepseek-reasoner`.
    return model === "deepseek-reasoner" ? undefined : 1.5;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveGenerationMaxAttempts(): number {
  const raw =
    process.env.DEEPSEEK_MAX_ATTEMPTS?.trim() ??
    process.env.LLM_MAX_ATTEMPTS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 1) {
    return Math.min(Math.floor(parsed), 10);
  }
  return 5;
}

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

function domainHashtags(domain: DomainFocusSlug): string[] {
  // Base always includes at least one audience hashtag so the repair fallback
  // satisfies the lint rule that requires one of #SaaS/#Startups/#TechLeadership/etc.
  const base = ["#SaaS", "#TechLeadership", "#FullStackDevelopment", "#AI"];
  const byDomain: Partial<Record<DomainFocusSlug, string[]>> = {
    aws: ["#AWS", "#CloudArchitecture"],
    serverless: ["#Serverless", "#AWSLambda"],
    iot: ["#IoT", "#Telemetry"],
    ci_cd: ["#CICD", "#Automation"],
    monitoring: ["#Observability", "#CloudWatch"],
    databases: ["#PostgreSQL", "#DataEngineering"],
    frontend: ["#Frontend", "#React"],
    llm_ops: ["#LLMOps", "#MLOps"],
    ai_integration: ["#AIEngineering", "#GenAI"],
    automation: ["#Automation", "#Python"],
    platforms: ["#PlatformEngineering", "#CloudInfrastructure"],
    ai_product_building: ["#AITools", "#ProductDevelopment", "#Startups"],
    saas_launch_lessons: ["#SaaS", "#Startups", "#ProductDevelopment"],
    client_delivery_stories: ["#Founders", "#TechLeadership", "#ProductDevelopment"],
    founder_technical_decisions: ["#CTOs", "#Startups", "#TechLeadership"],
    freelance_lessons: ["#Freelance", "#Founders", "#TechLeadership"],
    ai_integration_production: ["#AITools", "#CTOs", "#AI"],
  };
  return [...(byDomain[domain] ?? []), ...base];
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wordsToSentenceCase(words: string[]): string {
  const line = words.join(" ").trim();
  if (!line) {
    return "";
  }
  const normalized = line.replace(/\s+/g, " ");
  const first = normalized.charAt(0).toUpperCase();
  const rest = normalized.slice(1);
  return /[.!?]$/.test(normalized) ? `${first}${rest}` : `${first}${rest}.`;
}

function deterministicRepairPost(text: string, domain: DomainFocusSlug): string {
  const { min: wordMin, max: wordMax } = resolveWordBounds();
  const { min: hashMin, max: hashMax } = resolveHashtagBounds();
  const { prose, tagBlock } = splitProseAndHashtagBlock(normalizeWhitespace(text));

  const sourceWords = prose.split(/\s+/).filter(Boolean);
  const maxWords = Math.max(wordMin, wordMax);
  const cappedWords = sourceWords.slice(0, maxWords);
  let finalWords = cappedWords;
  if (finalWords.length < wordMin) {
    const filler =
      "I traced it with AWS Lambda logs, CloudWatch alarms, and Postgres query patterns before changing the rollout path.";
    finalWords = [...finalWords, ...filler.split(/\s+/)].slice(0, maxWords);
  }

  const chunks: string[] = [];
  for (let i = 0; i < finalWords.length; i += 38) {
    chunks.push(wordsToSentenceCase(finalWords.slice(i, i + 38)));
  }

  if (chunks.length === 0) {
    chunks.push(
      "I hit this in production while tracing an API path through AWS Lambda, CloudWatch, and Postgres.",
    );
  }

  if (!hasStrongHook(chunks[0] ?? "")) {
    chunks[0] = `One production issue kept repeating: ${(chunks[0] ?? "").replace(/\.$/, "")}.`;
  }

  const repairedProse = chunks.join("\n\n");
  const linted = lintLinkedInPost(`${repairedProse}\n\n${tagBlock}`.trim());
  const issueHashtagsMissing = linted.issues.some((i) => i.toLowerCase().includes("hashtag"));
  const issueStackMissing = linted.issues.some((i) => i.toLowerCase().includes("stack element"));
  const issueDense = linted.issues.some((i) => i.toLowerCase().includes("too dense"));

  const proseWithStack = issueStackMissing
    ? `${repairedProse}\n\nI validated the fix by checking CloudWatch logs, Lambda retries, and Postgres writes.`
    : repairedProse;

  const proseNoDense = issueDense
    ? proseWithStack
      .split(/\n\s*\n/)
      .flatMap((p) => p.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean))
      .join("\n\n")
    : proseWithStack;

  const existingTags = extractHashtags(tagBlock);
  const fallbackTags = domainHashtags(domain);
  const combinedTags = [...existingTags, ...fallbackTags]
    .filter((tag, index, arr) => arr.indexOf(tag) === index)
    .slice(0, hashMax);
  const minHashtags = Math.max(0, hashMin);
  const finalTags = (issueHashtagsMissing || combinedTags.length < minHashtags)
    ? [...domainHashtags(domain)].slice(0, Math.max(minHashtags, Math.min(hashMax, 6)))
    : combinedTags;

  const hashtagLine = finalTags.join(" ").trim();
  return hashtagLine ? `${proseNoDense.trim()}\n\n${hashtagLine}` : proseNoDense.trim();
}

/**
 * Targeted in-process repair for the most common Flash-class mistakes.
 *
 * Runs INSIDE the retry loop (cheaper than another DeepSeek call) so we can avoid
 * burning a full attempt on a fix the lint can do deterministically.
 *
 * Distinct from `deterministicRepairPost`, which is a more aggressive last-ditch
 * rewrite executed only after retries are exhausted.
 */
function autoRepairPost(post: string, issues: string[]): string {
  let repaired = post;

  // Fix: opening line starts with "I"
  if (issues.some((i) => i.includes('must not start with "I"'))) {
    const sentences = repaired.split(". ");
    if (sentences.length >= 2) {
      repaired = `${sentences[1]}. ${sentences[0]}. ${sentences.slice(2).join(". ")}`;
    }
  }

  // Fix: missing audience hashtag — append two safe defaults to the trailing tag line
  if (issues.some((i) => i.includes("audience hashtag"))) {
    repaired = repaired.replace(
      /(#\w+\s*)+$/,
      (match) => `${match.trim()} #SaaS #Startups`,
    );
  }

  // Fix: missing engagement question — insert a generic one above the hashtag line
  if (issues.some((i) => i.toLowerCase().includes("question"))) {
    repaired = repaired.replace(
      /(#\w+\s*)+$/,
      (match) => `\nHave you run into this in your own product?\n\n${match}`,
    );
  }

  return repaired.trim();
}

async function generateDeepSeekPost(options: {
  apiKey: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  draft: string;
  domainFocus: string;
  postType: PostType;
  postTypeGuidance: string;
  formatGuidance: string;
  runId: string;
  domain: DomainFocusSlug;
}): Promise<{ text: string; attempts: number; lint: PostLintResult }> {
  const maxAttempts = resolveGenerationMaxAttempts();
  let attempts = 0;
  let text = "";
  let lint: PostLintResult = {
    ok: false,
    issues: [],
    warnings: [],
    wordCount: 0,
    hashtagCount: 0,
    charCount: 0,
  };

  while (attempts < maxAttempts) {
    attempts += 1;

    if (attempts === 1) {
      text = await polishWithDeepSeek(options);
    } else {
      const revisionNotes = `The previous draft failed validation with these issues: ${lint.issues.join(
        "; ",
      )}. Rewrite the entire post so it passes every validator rule exactly. Do not keep weak lines from the failed draft. Remaining attempts including this one: ${maxAttempts - attempts + 1}.`;
      text = await polishWithDeepSeek({
        ...options,
        revisionNotes,
        draft: text,
      });
    }

    lint = lintLinkedInPost(text);
    if (lint.ok) {
      break;
    }

    console.error(
      `[LinkedIn] Lint failure on attempt ${attempts}/${maxAttempts}:`,
      {
        runId: options.runId,
        domain: options.domain,
        postType: options.postType,
        issues: lint.issues,
        wordCount: lint.wordCount,
        hashtagCount: lint.hashtagCount,
        firstLine: text.split("\n")[0]?.substring(0, 80) ?? "",
      },
    );

    // Try targeted in-process auto-repair before burning the next DeepSeek attempt.
    const repaired = autoRepairPost(text, lint.issues);
    if (repaired !== text) {
      const repairedLint = lintLinkedInPost(repaired);
      if (repairedLint.ok) {
        console.log(
          `[LinkedIn] Auto-repair succeeded on attempt ${attempts}/${maxAttempts}`,
          { runId: options.runId, repairedIssues: lint.issues },
        );
        text = repaired;
        lint = repairedLint;
        break;
      }
    }
  }

  return { text, attempts, lint };
}

async function resolveContentEntropy(runId: string): Promise<{
  entropy: string;
  domainSlug: DomainFocusSlug;
  postType: PostType;
}> {
  const memory = await loadPostMemory();
  const recent = memory.slice(-10);
  for (let i = 0; i < 16; i += 1) {
    const entropy = i === 0 ? runId : `${runId}|repick|${i}`;
    const domainSlug = pickDomainFocusForRun(entropy);
    const postType = pickPostType(entropy);
    const clash = recent.some(
      (r) => r.domain === domainSlug && r.postType === postType,
    );
    if (!clash) {
      return { entropy, domainSlug, postType };
    }
  }
  const entropy = `${runId}|${Date.now()}`;
  return {
    entropy,
    domainSlug: pickDomainFocusForRun(entropy),
    postType: pickPostType(entropy),
  };
}

function logPublishedPost(info: {
  bufferPostId?: string;
  pillarId: string;
  formatIndex: number;
  formatKey: string;
  domainFocus: DomainFocusSlug;
  postType: PostType;
  llmModel: string | null;
  contentSource: "template" | "deepseek";
  draftChars: number;
  finalText: string;
  postNow: boolean;
  scheduledDueAt?: string;
  runId: string;
  ideaId?: string;
}): void {
  const { prose, tagBlock } = splitProseAndHashtagBlock(info.finalText);
  const tagSource = tagBlock.length > 0 ? tagBlock : info.finalText;
  const payload = {
    event: "post_published",
    runId: info.runId,
    bufferPostId: info.bufferPostId ?? null,
    ideaId: info.ideaId ?? null,
    pillar: { id: info.pillarId },
    template: { index: info.formatIndex, key: info.formatKey },
    domainFocus: info.domainFocus,
    postType: info.postType,
    llm: {
      model: info.llmModel,
      used: info.contentSource === "deepseek",
    },
    contentSource: info.contentSource,
    lengths: {
      draftChars: info.draftChars,
      finalCharsGraphemes: [...info.finalText].length,
      finalCharsJsLength: info.finalText.length,
      proseWordCount: countWords(prose),
      hashtagCount: extractHashtags(tagSource).length,
    },
    schedule: info.postNow
      ? { mode: "buffer_now" as const }
      : { mode: "buffer_scheduled" as const, dueAt: info.scheduledDueAt },
  };
  console.log("[linkedin-automation]", JSON.stringify(payload, null, 2));
}

/**
 * 1) Build post from `data/pillars.json` (unique copy per run entropy)
 * 2) Polish with DeepSeek (`DEEPSEEK_API_KEY` or `DeepseekAPIKey`)
 * 3) `createPost` on Buffer Publish GraphQL
 * 4) Optionally mirror to your Ideas GraphQL (`GRAPHQL_IDEAS_*`)
 */
export async function runLinkedInAutomation(postNow: boolean): Promise<Response> {
  const gqlKey = process.env.BUFFER_API_KEY?.trim();
  const gqlChannel = process.env.BUFFER_CHANNEL_ID?.trim();
  if (!gqlKey || !gqlChannel) {
    return Response.json(
      {
        ok: false,
        error: "Set BUFFER_API_KEY and BUFFER_CHANNEL_ID for Buffer Publish GraphQL.",
      },
      { status: 500 },
    );
  }

  const deepseekKey =
    process.env.DEEPSEEK_API_KEY?.trim() ||
    process.env.DeepseekAPIKey?.trim();
  if (!deepseekKey && !allowTemplatePublish()) {
    return Response.json(
      {
        ok: false,
        error:
          "DEEPSEEK_API_KEY is required. Posts are DeepSeek-generated only unless you set ALLOW_TEMPLATE_PUBLISH=true for local debugging.",
      },
      { status: 503 },
    );
  }

  const templateOnly =
    process.env.FORCE_TEMPLATE_ONLY === "true" || !deepseekKey;

  const runId = randomUUID();
  const { entropy, domainSlug, postType } = await resolveContentEntropy(runId);
  const draftMeta = buildDraftPost(new Date(), entropy);
  const domainPrompt = domainFocusForPrompt(domainSlug);
  const resolvedLlmModel =
    process.env.DEEPSEEK_MODEL?.trim() ||
    process.env.DeepseekModel?.trim() ||
    DEFAULT_DEEPSEEK_MODEL;
  let text = draftMeta.text;
  let source: "template" | "deepseek" = "template";
  let llmError: string | undefined;
  let generationAttempts = 0;

  if (!templateOnly && deepseekKey) {
    try {
      const result = await generateDeepSeekPost({
        apiKey: deepseekKey,
        model: resolvedLlmModel,
        baseUrl: process.env.DEEPSEEK_BASE_URL?.trim(),
        temperature: resolveLlmTemperature(resolvedLlmModel),
        draft: draftMeta.text,
        domainFocus: domainPrompt,
        postType,
        postTypeGuidance: postTypeGuidance(postType),
        formatGuidance: draftMeta.formatGuidance,
        runId,
        domain: domainSlug,
      });
      text = result.text;
      generationAttempts = result.attempts;
      source = "deepseek";
    } catch (e) {
      const message = e instanceof Error ? e.message : "DeepSeek error";
      const strict =
        process.env.DEEPSEEK_STRICT === "true" ||
        process.env.LLM_STRICT === "true" ||
        process.env.GEMINI_STRICT === "true";
      if (strict || !allowTemplatePublish()) {
        return Response.json(
          {
            ok: false,
            failure_stage: "deepseek" as const,
            error: message,
            hint: strict
              ? "Unset DEEPSEEK_STRICT or fix DEEPSEEK_API_KEY / model."
              : "DeepSeek must succeed for publishing. Fix the API key, balance, base URL, or model; or set ALLOW_TEMPLATE_PUBLISH=true only for local template debugging.",
          },
          { status: 502 },
        );
      }
      text = draftMeta.text;
      source = "template";
      llmError = message;
    }
  }

  if (source === "template" && !allowTemplatePublish()) {
    return Response.json(
      {
        ok: false,
        error: "Template posts must not be published.",
      },
      { status: 503 },
    );
  }

  const bannedHits = lintBannedPhrases(text);

  let lint = lintLinkedInPost(text);
  if (!lint.ok && source === "deepseek") {
    const repaired = deterministicRepairPost(text, domainSlug);
    const repairedLint = lintLinkedInPost(repaired);
    if (repairedLint.ok) {
      text = repaired;
      lint = repairedLint;
    }
  }
  if (!lint.ok) {
    const maxAttempts = resolveGenerationMaxAttempts();
    return Response.json(
      {
        ok: false,
        reason: "max_retries_exhausted" as const,
        error:
          "Post rejected: does not meet LinkedIn rules (hashtags, word count, hook, etc.).",
        issues: lint.issues,
        lint,
        source,
        attempts: generationAttempts || maxAttempts,
      },
      { status: 422 },
    );
  }

  const textToPost = applyOptionalPostNonce(text);

  const scheduledDueAtIso = postNow ? undefined : queueDueAtIso();

  const gqlResult = await bufferCreatePostGraphql({
    apiKey: gqlKey,
    channelId: gqlChannel,
    text: textToPost,
    postNow,
    queueDueAt: scheduledDueAtIso,
  });

  if (!gqlResult.success) {
    const errMsg = gqlResult.message ?? "Buffer GraphQL create failed";
    return Response.json(
      {
        ok: false,
        error: errMsg,
        hint: isBufferDuplicatePostError(errMsg)
          ? "Buffer blocked duplicate/near-duplicate text. Wait and retry, change pillars/copy, or set APPEND_POST_NONCE=true in .env for local testing only."
          : undefined,
        source,
        buffer_now: postNow,
        text_preview: textToPost.slice(0, 280),
      },
      { status: 502 },
    );
  }

  const updateId = gqlResult.postId;

  const warnings: Record<string, unknown> = {};
  if (bannedHits.length > 0) {
    warnings.banned_phrases_detected = bannedHits;
  }
  if (llmError) {
    warnings.deepseek_skipped = llmError;
  }
  if (source === "deepseek" && generationAttempts > 1) {
    warnings.deepseek_retries = generationAttempts - 1;
  }
  if (source !== "deepseek") {
    warnings.post_rules =
      "Template path (ALLOW_TEMPLATE_PUBLISH): for debugging only; prefer DeepSeek in all real environments.";
  }

  let ideaId: string | undefined;
  const ideasUrl = process.env.GRAPHQL_IDEAS_URL?.trim();
  const ideasToken = process.env.GRAPHQL_IDEAS_TOKEN?.trim();
  const orgId = process.env.IDEAS_ORGANIZATION_ID?.trim();
  const syncIdea = process.env.SYNC_IDEA_TO_GRAPHQL !== "false";

  if (syncIdea && ideasUrl && ideasToken && orgId) {
    const ideaResult = await createIdeaViaGraphql({
      endpoint: ideasUrl,
      token: ideasToken,
      organizationId: orgId,
      title: titleFromPostBody(textToPost),
      text: textToPost,
      authMode: process.env.GRAPHQL_IDEAS_AUTH_MODE,
    });
    if (!ideaResult.ok) {
      warnings.idea_sync_failed = ideaResult.message;
    } else {
      ideaId = ideaResult.id;
    }
  }

  const { prose, tagBlock } = splitProseAndHashtagBlock(textToPost);
  const tagSource = tagBlock.length > 0 ? tagBlock : textToPost;
  const metadata = {
    postType,
    domainFocus: domainSlug,
    wordCount: countWords(prose),
    hashtagCount: extractHashtags(tagSource).length,
    pillarId: draftMeta.pillarId,
    templateKey: draftMeta.formatKey,
  };

  await appendPostMemory({
    domain: domainSlug,
    postType,
    at: new Date().toISOString(),
  });

  logPublishedPost({
    bufferPostId: updateId,
    pillarId: draftMeta.pillarId,
    formatIndex: draftMeta.formatIndex,
    formatKey: draftMeta.formatKey,
    domainFocus: domainSlug,
    postType,
    llmModel: source === "deepseek" ? resolvedLlmModel : null,
    contentSource: source,
    draftChars: [...draftMeta.text].length,
    finalText: textToPost,
    postNow,
    scheduledDueAt: scheduledDueAtIso,
    runId,
    ideaId,
  });

  return Response.json({
    ok: true,
    source,
    buffer_now: postNow,
    buffer_post_id: updateId,
    buffer_update_id: updateId,
    scheduled_due_at: scheduledDueAtIso,
    idea_id: ideaId,
    metadata,
    warnings: Object.keys(warnings).length > 0 ? warnings : undefined,
    text_preview: textToPost.slice(0, 400),
  });
}
