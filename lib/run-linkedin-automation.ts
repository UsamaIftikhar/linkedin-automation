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
  lintLinkedInPost,
  pickDomainFocusForRun,
  splitProseAndHashtagBlock,
  type DomainFocusSlug,
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
}): Promise<{ text: string; attempts: number }> {
  const maxAttempts = resolveGenerationMaxAttempts();
  let attempts = 1;
  let text = await polishWithDeepSeek(options);
  let lint = lintLinkedInPost(text);

  while (!lint.ok && attempts < maxAttempts) {
    attempts += 1;
    const revisionNotes = `The previous draft failed validation with these issues: ${lint.issues.join(
      "; ",
    )}. Rewrite the entire post so it passes every validator rule exactly. Do not keep weak lines from the failed draft. Remaining attempts including this one: ${maxAttempts - attempts + 1}.`;
    text = await polishWithDeepSeek({
      ...options,
      revisionNotes,
      draft: text,
    });
    lint = lintLinkedInPost(text);
  }

  return { text, attempts };
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

  const lint = lintLinkedInPost(text);
  if (!lint.ok) {
    return Response.json(
      {
        ok: false,
        error:
          "Post rejected: does not meet LinkedIn rules (hashtags, word count, hook, concrete stack detail, etc.).",
        issues: lint.issues,
        lint,
        source,
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
