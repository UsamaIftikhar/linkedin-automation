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
import { PipelineLogger, textFingerprint } from "@/lib/pipeline-log";
import { reviewPostCoherence } from "@/lib/post-reviewer";
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
    // Default lowered from 1.5 → 0.4. Higher temperatures cause Flash-class
    // models to tail-collapse: the post starts coherent and degenerates into
    // word-salad ("loire side potential", "re-calks", "oversacificing"). At
    // 0.4 the model stays anchored to coherent next-token probabilities.
    // Creativity comes from the pillar/domain/post-type variation, not from
    // temperature. DeepSeek ignores this for `deepseek-reasoner`.
    return model === "deepseek-reasoner" ? undefined : 0.4;
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
  // Default 2: attempt 1 + one fresh retry for true incoherence only.
  // Formatting fixes are handled deterministically on attempt 1.
  return 2;
}

/**
 * Wall-clock budget for the whole run, in ms. We must leave ~15s headroom for
 * the Buffer GraphQL call and JSON I/O after generation, so we cap generation
 * at ~40s when the route's maxDuration is 60s.
 */
function resolveRunBudgetMs(): number {
  const raw = process.env.RUN_BUDGET_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 10_000) {
    return parsed;
  }
  return 40_000;
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

/**
 * Detect output that looks incoherent / word-salad. Word-chunking repairs used
 * to publish posts containing things like "deployment winery" or "The fix flat
 * e slow branching leads to possible but rare generation..." — that's worse
 * than skipping a day. These heuristics catch the most damaging patterns.
 *
 * Returns a reason code if the prose looks incoherent, or null if it looks OK.
 */
function detectIncoherence(prose: string): string | null {
  // Single-letter "words" outside of "I" and "a" (e.g. the orphan "e" in
  // "The fix flat e slow branching...").
  const singleLetters = prose.match(/\b(?![Ii]\b|[Aa]\b)[a-z]\b/g) ?? [];
  if (singleLetters.length > 0) {
    return `single_letter_tokens(${singleLetters.length})`;
  }
  // Period directly followed by a capital letter without a space — sign of a
  // sentence having been spliced into another (e.g. "Data.Halfway synced").
  const jammed = prose.match(/[a-z]\.[A-Z]/g) ?? [];
  if (jammed.length > 1) {
    return `period_jamming(${jammed.length})`;
  }
  // Three or more "..." or repeated standalone hyphens — model dump indicator.
  if (/\s---\s/.test(prose) || /\.{4,}/.test(prose)) {
    return "stray_separators";
  }
  return null;
}

/**
 * Reject sentences that look broken on their own, before they get assembled
 * into a post. Used by sentence-based repair below.
 */
function looksLikeBrokenSentence(sentence: string): boolean {
  const words = sentence.split(/\s+/).filter(Boolean);
  if (words.length < 4 || words.length > 45) {
    return true;
  }
  // Single-letter tokens (orphan "e", "s", etc.)
  if (words.some((w) => /^[a-z]$/i.test(w.replace(/[.,!?;:]/g, "")) && w.toLowerCase() !== "a" && w.toLowerCase() !== "i")) {
    return true;
  }
  // Ends in a function word (e.g. "manually or.").
  const TRAILING_FUNCTION_WORDS = new Set([
    "or", "and", "but", "the", "a", "an", "of", "to", "in", "on", "at",
    "for", "with", "by", "as", "if", "is", "are", "was", "were", "be", "yes", "no",
  ]);
  const last = (words[words.length - 1] ?? "").replace(/[.,!?;:]$/, "").toLowerCase();
  if (TRAILING_FUNCTION_WORDS.has(last)) {
    return true;
  }
  // No vowels in a "word" longer than 2 chars — usually transcription noise.
  if (words.some((w) => {
    const stripped = w.replace(/[^a-zA-Z]/g, "");
    return stripped.length > 2 && !/[aeiouy]/i.test(stripped);
  })) {
    return true;
  }
  return false;
}

export type RepairResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/**
 * Sentence-aware repair: pick complete sentences from the model output that
 * pass coherence heuristics, accumulate until we hit the word range, fix the
 * hook + hashtags + question rules. NEVER synthesize text from word chunks —
 * that approach (the prior implementation) published word-salad whenever the
 * model rambled.
 *
 * Returns { ok: false } when the model output has no usable coherent content.
 * The caller MUST treat that as "skip the day" rather than try to publish.
 */
function deterministicRepairPost(text: string, domain: DomainFocusSlug): RepairResult {
  const { min: wordMin, max: wordMax } = resolveWordBounds();
  const { min: hashMin, max: hashMax } = resolveHashtagBounds();
  const { prose, tagBlock } = splitProseAndHashtagBlock(normalizeWhitespace(text));

  // Up-front coherence check on the raw model prose. If the raw output is
  // obviously broken, no amount of sentence picking will save it.
  const incoherent = detectIncoherence(prose);
  if (incoherent) {
    return { ok: false, reason: `incoherent_source(${incoherent})` };
  }

  const sentences = prose
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const goodSentences = sentences.filter((s) => !looksLikeBrokenSentence(s));
  if (goodSentences.length === 0) {
    return { ok: false, reason: "no_usable_sentences" };
  }

  // Pick sentences in order until word count reaches [wordMin, wordMax].
  const picked: string[] = [];
  let words = 0;
  for (const s of goodSentences) {
    const w = s.split(/\s+/).filter(Boolean).length;
    if (words + w > wordMax) {
      // Adding this sentence would overflow. If we're already at wordMin, stop;
      // otherwise skip and try the next (shorter) sentence.
      if (words >= wordMin) break;
      continue;
    }
    picked.push(s);
    words += w;
    if (words >= wordMin) {
      // We have enough; one more sentence is OK but not required.
      break;
    }
  }

  if (words < wordMin || picked.length === 0) {
    return { ok: false, reason: `insufficient_coherent_text(${words}/${wordMin})` };
  }

  // Hook rule: first sentence MUST NOT start with "I " (lint check) and SHOULD
  // satisfy hasStrongHook (separate lint check). If the first picked sentence
  // fails, search for a replacement among the remaining good sentences.
  if (/^I\s/i.test(picked[0]!) || !hasStrongHook(picked[0]!)) {
    const replacementIdx = goodSentences.findIndex(
      (s) => !picked.includes(s) && !/^I\s/i.test(s) && hasStrongHook(s),
    );
    if (replacementIdx >= 0) {
      const replacement = goodSentences[replacementIdx]!;
      const replacementWords = replacement.split(/\s+/).filter(Boolean).length;
      const firstWords = picked[0]!.split(/\s+/).filter(Boolean).length;
      // Only swap if the budget still fits after the swap.
      if (words - firstWords + replacementWords <= wordMax) {
        picked.unshift(replacement);
        picked.splice(1, 1); // drop the original first
        words = words - firstWords + replacementWords;
      } else {
        // Fall back to a quick prepend that satisfies both rules.
        picked.unshift("Most teams hit this same wall in production.");
        words += 7;
      }
    } else {
      // No coherent alternative — prepend a safe hook sentence.
      picked.unshift("Most teams hit this same wall in production.");
      words += 7;
    }
  }

  // If we accidentally went over wordMax with the hook prepend, drop sentences
  // from the tail until we fit.
  while (words > wordMax && picked.length > 1) {
    const last = picked.pop()!;
    words -= last.split(/\s+/).filter(Boolean).length;
  }

  let repairedProse = picked.join("\n\n");

  // Hashtag handling: prefer the model's hashtags if they pass the rules,
  // otherwise build a domain-appropriate fallback. Cap at hashMax.
  const existingTags = extractHashtags(tagBlock);
  const fallbackTags = domainHashtags(domain);
  const combinedTags = [...existingTags, ...fallbackTags]
    .filter((tag, index, arr) => arr.indexOf(tag) === index)
    .slice(0, hashMax);
  const minHashtags = Math.max(0, hashMin);
  const finalTags = combinedTags.length >= minHashtags
    ? combinedTags
    : [...domainHashtags(domain)].slice(0, Math.max(minHashtags, Math.min(hashMax, 6)));

  // Question rule: post must contain a `?`. Append a generic one if missing.
  if (!/\?/.test(repairedProse)) {
    repairedProse += `\n\nWhat caught your team off guard the last time you shipped this kind of change?`;
  }

  const hashtagLine = finalTags.join(" ").trim();
  const finalText = hashtagLine
    ? `${repairedProse.trim()}\n\n${hashtagLine}`
    : repairedProse.trim();

  // Final lint check + final coherence check. If either fails, refuse to publish.
  const finalLint = lintLinkedInPost(finalText);
  if (!finalLint.ok) {
    return { ok: false, reason: `lint_still_failing(${finalLint.issues.slice(0, 2).join(" | ")})` };
  }
  const finalIncoherence = detectIncoherence(repairedProse);
  if (finalIncoherence) {
    return { ok: false, reason: `repair_introduced_incoherence(${finalIncoherence})` };
  }

  return { ok: true, text: finalText };
}

const FORMATTING_ISSUE_MARKERS = [
  "missing hashtags",
  "dedicated final line",
  "too dense",
  "audience hashtag",
  "post must contain a question",
] as const;

function isOnlyFormatting(issues: string[]): boolean {
  if (issues.length === 0) {
    return false;
  }
  return issues.every((issue) =>
    FORMATTING_ISSUE_MARKERS.some((marker) =>
      issue.toLowerCase().includes(marker),
    ),
  );
}

function fixDenseParagraphs(prose: string): string {
  const paragraphs = prose
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paragraphs
    .flatMap((paragraph) => {
      const sentences = paragraph
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (sentences.length <= 2) {
        return [paragraph];
      }
      const chunks: string[] = [];
      for (let i = 0; i < sentences.length; i += 2) {
        chunks.push(sentences.slice(i, i + 2).join(" "));
      }
      return chunks;
    })
    .join("\n\n");
}

function fixHashtagLine(text: string, domain: DomainFocusSlug): string {
  const { min: hashMin, max: hashMax } = resolveHashtagBounds();
  const collected = extractHashtags(text);
  let prose = text.replace(/#[A-Za-z][A-Za-z0-9_]*/g, " ");
  prose = prose
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const uniqueTags = [...collected];
  for (const tag of domainHashtags(domain)) {
    if (uniqueTags.length >= hashMax) {
      break;
    }
    if (!uniqueTags.includes(tag)) {
      uniqueTags.push(tag);
    }
  }
  while (uniqueTags.length < hashMin) {
    let added = false;
    for (const tag of domainHashtags(domain)) {
      if (!uniqueTags.includes(tag)) {
        uniqueTags.push(tag);
        added = true;
        if (uniqueTags.length >= hashMin) {
          break;
        }
      }
    }
    if (!added) {
      break;
    }
  }

  const hashtagLine = uniqueTags.slice(0, hashMax).join(" ").trim();
  return hashtagLine ? `${prose}\n\n${hashtagLine}` : prose;
}

/**
 * Targeted in-process repair for formatting-only lint failures.
 * Safe on attempt-1 coherent posts — does not rewrite meaning.
 */
function autoRepairPost(
  post: string,
  issues: string[],
  domain: DomainFocusSlug,
): string {
  let repaired = post;

  const needsHashtagFix = issues.some(
    (i) =>
      i.toLowerCase().includes("missing hashtags") ||
      i.toLowerCase().includes("dedicated final line"),
  );
  if (needsHashtagFix) {
    repaired = fixHashtagLine(repaired, domain);
  }

  if (issues.some((i) => i.toLowerCase().includes("too dense"))) {
    const { prose, tagBlock } = splitProseAndHashtagBlock(repaired);
    const fixedProse = fixDenseParagraphs(prose);
    repaired = tagBlock.trim()
      ? `${fixedProse}\n\n${tagBlock.trim()}`
      : fixedProse;
  }

  // Fix: opening line starts with "I"
  if (issues.some((i) => i.includes('must not start with "I"'))) {
    const sentences = repaired.split(". ");
    if (sentences.length >= 2) {
      repaired = `${sentences[1]}. ${sentences[0]}. ${sentences.slice(2).join(". ")}`;
    }
  }

  // Fix: missing audience hashtag — append defaults to the trailing tag line
  if (issues.some((i) => i.toLowerCase().includes("audience hashtag"))) {
    if (/(#\w+\s*)+$/.test(repaired)) {
      repaired = repaired.replace(
        /(#\w+\s*)+$/,
        (match) => `${match.trim()} #SaaS #Startups`,
      );
    } else {
      repaired = fixHashtagLine(repaired, domain);
    }
  }

  // Fix: missing engagement question — insert above the hashtag line
  if (issues.some((i) => i.toLowerCase().includes("question"))) {
    if (/(#\w+\s*)+$/.test(repaired)) {
      repaired = repaired.replace(
        /(#\w+\s*)+$/,
        (match) => `\nHave you run into this in your own product?\n\n${match}`,
      );
    } else {
      repaired = `${repaired.trim()}\n\nHave you run into this in your own product?`;
    }
  }

  return repaired.trim();
}

async function tryAcceptWithReview(
  candidateText: string,
  candidateLint: PostLintResult,
  ctx: {
    pipelineLog: PipelineLogger;
    attempt: number;
    runId: string;
    signal: AbortSignal;
    stepPrefix: string;
  },
): Promise<{ accepted: boolean; reviewIncoherent: boolean; reviewIssues: string[] }> {
  if (!candidateLint.ok) {
    return { accepted: false, reviewIncoherent: false, reviewIssues: [] };
  }

  const review = await reviewPostCoherence({
    postText: candidateText,
    signal: ctx.signal,
  });
  const passed =
    review.coherent && review.readable && review.professional;
  ctx.pipelineLog.step(`${ctx.stepPrefix}.semantic`, {
    attempt: ctx.attempt,
    coherent: review.coherent,
    readable: review.readable,
    professional: review.professional,
    issues: review.issues,
    passed,
  });

  if (passed) {
    ctx.pipelineLog.step("deepseek.generation_success", { attempt: ctx.attempt });
    return { accepted: true, reviewIncoherent: false, reviewIssues: [] };
  }

  console.error("[LinkedIn] Reviewer rejected post", {
    runId: ctx.runId,
    attempt: ctx.attempt,
    step: ctx.stepPrefix,
    issues: review.issues,
    head: candidateText.slice(0, 120),
  });
  return {
    accepted: false,
    reviewIncoherent: true,
    reviewIssues: review.issues,
  };
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
  deadline: number;
  pipelineLog: PipelineLogger;
}): Promise<{ text: string; attempts: number; lint: PostLintResult; timedOut: boolean }> {
  const maxAttempts = resolveGenerationMaxAttempts();
  let attempts = 0;
  let timedOut = false;
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
    const remainingMs = options.deadline - Date.now();
    if (remainingMs < 8_000) {
      options.pipelineLog.step("deepseek.budget_exhausted", {
        attemptNext: attempts + 1,
        maxAttempts,
        remainingMs,
      });
      console.warn(
        `[LinkedIn] Wall-clock budget exhausted before attempt ${attempts + 1}/${maxAttempts} (remaining=${remainingMs}ms). Bailing to deterministic repair.`,
      );
      timedOut = true;
      break;
    }
    attempts += 1;

    const perAttemptMs = Math.max(5_000, remainingMs - 4_000);
    const attemptSignal = AbortSignal.timeout(perAttemptMs);

    // Per-attempt try/catch: a timeout or network error on attempt N must NOT
    // abort the whole loop. If we still have budget left, the next iteration
    // re-checks the wall clock and either retries or bails to deterministic
    // repair. If every attempt errors, we return the last (possibly empty) text
    // with timedOut=true so the caller can fall back to the template draft.
    try {
      if (attempts === 1) {
        text = await polishWithDeepSeek({
          ...options,
          signal: attemptSignal,
          pipelineLog: options.pipelineLog,
          attempt: attempts,
        });
      } else {
        const revisionNotes = `The previous attempt produced incoherent text. Ignore it completely. Generate a brand new post from the original angle. These lint issues must not recur: ${lint.issues.join("; ")}. Remaining attempts including this one: ${maxAttempts - attempts + 1}.`;
        options.pipelineLog.step("deepseek.retry_start", {
          attempt: attempts,
          previousOutputFingerprint: textFingerprint(text),
          retryDraftSource: "pillar_template",
          lintIssues: lint.issues,
        });
        options.pipelineLog.snapshot(
          "deepseek.retry_draft_reset",
          options.draft,
          "pillar_template_fresh_on_retry",
          { attempt: attempts },
        );
        text = await polishWithDeepSeek({
          ...options,
          revisionNotes,
          draft: options.draft,
          signal: attemptSignal,
          pipelineLog: options.pipelineLog,
          attempt: attempts,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout = /timed out|aborted|TimeoutError|AbortError/i.test(msg);
      options.pipelineLog.step("deepseek.attempt_error", {
        attempt: attempts,
        isTimeout,
        error: msg,
      });
      console.warn(
        `[LinkedIn] DeepSeek attempt ${attempts}/${maxAttempts} failed (${isTimeout ? "timeout" : "error"}): ${msg}`,
      );
      timedOut = timedOut || isTimeout;
      // Don't break: let the loop's wall-clock check decide whether another
      // attempt is feasible. If not, we exit cleanly with timedOut=true.
      continue;
    }

    lint = lintLinkedInPost(text);
    options.pipelineLog.step("lint.after_deepseek_attempt", {
      attempt: attempts,
      lintOk: lint.ok,
      issues: lint.issues,
      warnings: lint.warnings,
      wordCount: lint.wordCount,
      hashtagCount: lint.hashtagCount,
      charCount: lint.charCount,
      outputFingerprint: textFingerprint(text),
    });

    const reviewCtx = {
      pipelineLog: options.pipelineLog,
      attempt: attempts,
      runId: options.runId,
      signal: attemptSignal,
      stepPrefix: "review",
    };

    // Path A: lint already passes — reviewer is the only gate.
    let accept = await tryAcceptWithReview(text, lint, reviewCtx);
    if (accept.accepted) {
      break;
    }
    if (lint.ok && accept.reviewIncoherent) {
      lint = {
        ...lint,
        ok: false,
        issues: [...lint.issues, ...accept.reviewIssues],
      };
      options.pipelineLog.step("generation.regenerate_decision", {
        attempt: attempts,
        shouldRegenerate: attempts < maxAttempts,
        reason: "reviewer_rejected_lint_pass_post",
      });
      if (attempts < maxAttempts) {
        continue;
      }
      break;
    }

    // Path B: formatting repair on the CURRENT text — never discard attempt-1
    // coherent prose for a formatting-only lint failure.
    const beforeAuto = text;
    const repaired = autoRepairPost(text, lint.issues, options.domain);
    if (repaired !== beforeAuto) {
      options.pipelineLog.snapshot("repair.auto_before", beforeAuto, "before_auto_repair", {
        attempt: attempts,
        issues: lint.issues,
      });
      options.pipelineLog.snapshot("repair.auto_after", repaired, "after_auto_repair", {
        attempt: attempts,
        changed: true,
      });
    } else {
      options.pipelineLog.step("repair.auto_skipped", {
        attempt: attempts,
        reason: "no_applicable_auto_fix",
      });
    }

    const repairedLint = lintLinkedInPost(repaired);
    options.pipelineLog.step("lint.after_auto_repair", {
      attempt: attempts,
      lintOk: repairedLint.ok,
      issues: repairedLint.issues,
      onlyFormatting: isOnlyFormatting(repairedLint.issues),
    });

    accept = await tryAcceptWithReview(repaired, repairedLint, {
      ...reviewCtx,
      stepPrefix: "review.after_auto_repair",
    });
    if (accept.accepted) {
      text = repaired;
      lint = repairedLint;
      break;
    }

    const combinedIssues = [
      ...new Set([
        ...lint.issues,
        ...repairedLint.issues,
        ...accept.reviewIssues,
      ]),
    ];
    const shouldRegenerate =
      !isOnlyFormatting(combinedIssues) || accept.reviewIncoherent;

    options.pipelineLog.step("generation.regenerate_decision", {
      attempt: attempts,
      shouldRegenerate,
      isOnlyFormatting: isOnlyFormatting(combinedIssues),
      combinedIssues,
      reviewIncoherent: accept.reviewIncoherent,
    });

    console.error(
      `[LinkedIn] Lint failure on attempt ${attempts}/${maxAttempts}:`,
      {
        runId: options.runId,
        domain: options.domain,
        postType: options.postType,
        issues: combinedIssues,
        wordCount: repairedLint.wordCount,
        hashtagCount: repairedLint.hashtagCount,
        firstLine: text.split("\n")[0]?.substring(0, 80) ?? "",
        shouldRegenerate,
      },
    );

    if (!shouldRegenerate) {
      text = repaired;
      lint = repairedLint;
      break;
    }

    if (attempts >= maxAttempts) {
      text = repaired;
      lint = accept.reviewIncoherent
        ? {
            ...repairedLint,
            ok: false,
            issues: [...repairedLint.issues, ...accept.reviewIssues],
          }
        : repairedLint;
      break;
    }
  }

  options.pipelineLog.step("deepseek.generation_complete", {
    attempts,
    timedOut,
    finalFingerprint: text ? textFingerprint(text) : null,
    lintOk: lint.ok,
  });

  return { text, attempts, lint, timedOut };
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
export async function runLinkedInAutomation(
  postNow: boolean,
  dryRun = process.env.DRY_RUN === "true",
): Promise<Response> {
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

  const runStartedAt = Date.now();
  const deadline = runStartedAt + resolveRunBudgetMs();
  const runId = randomUUID();
  const pipelineLog = new PipelineLogger(runId);
  const resolvedLlmModel =
    process.env.DEEPSEEK_MODEL?.trim() ||
    process.env.DeepseekModel?.trim() ||
    DEFAULT_DEEPSEEK_MODEL;

  pipelineLog.step("pipeline.start", {
    postNow,
    dryRun,
    templateOnly,
    model: resolvedLlmModel,
    temperature: resolveLlmTemperature(resolvedLlmModel),
    maxAttempts: resolveGenerationMaxAttempts(),
    runBudgetMs: resolveRunBudgetMs(),
    deepseekTimeoutMs: process.env.DEEPSEEK_TIMEOUT_MS ?? "25000",
    maxTokens: process.env.DEEPSEEK_MAX_TOKENS ?? "900(default)",
  });

  const { entropy, domainSlug, postType } = await resolveContentEntropy(runId);
  const draftMeta = buildDraftPost(new Date(), entropy);
  const domainPrompt = domainFocusForPrompt(domainSlug);

  pipelineLog.step("content.pillar_picked", {
    entropy,
    pillarId: draftMeta.pillarId,
    formatKey: draftMeta.formatKey,
    formatIndex: draftMeta.formatIndex,
    domain: domainSlug,
    postType,
    domainPrompt,
  });
  pipelineLog.snapshot("content.template_draft", draftMeta.text, "pillar_template_before_llm");

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
        deadline,
        pipelineLog,
      });
      generationAttempts = result.attempts;
      if (result.text.trim().length > 0) {
        text = result.text;
        source = "deepseek";
        pipelineLog.snapshot("content.after_deepseek_loop", text, "final_text_from_generation_loop");
      } else {
        // Every DeepSeek attempt errored (timeouts, network, etc.). Use the
        // template draft and rely on deterministic repair to produce a
        // publishable post. DO NOT 502 here — the deterministic repair is the
        // contract we promise the cron, and the function still has time left.
        console.warn(
          `[LinkedIn] All ${result.attempts} DeepSeek attempts failed; falling back to deterministic repair on template draft (timedOut=${result.timedOut}).`,
        );
        pipelineLog.step("deepseek.all_attempts_failed", {
          attempts: result.attempts,
          timedOut: result.timedOut,
          fallback: "pillar_template",
        });
        text = draftMeta.text;
        source = "deepseek"; // keep so deterministic repair gate fires below
        llmError = result.timedOut ? "deepseek_all_attempts_timed_out" : "deepseek_all_attempts_failed";
      }
    } catch (e) {
      // generateDeepSeekPost should no longer throw — per-attempt errors are
      // caught internally. This catch is a defensive safety net for unexpected
      // synchronous failures (e.g. lintLinkedInPost throwing). Same fallback.
      const message = e instanceof Error ? e.message : "DeepSeek error";
      console.warn(
        `[LinkedIn] generateDeepSeekPost threw unexpectedly: ${message}. Falling back to template + deterministic repair.`,
      );
      pipelineLog.step("deepseek.unexpected_throw", { error: message });
      text = draftMeta.text;
      source = "deepseek";
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
  pipelineLog.step("lint.before_deterministic_repair", {
    lintOk: lint.ok,
    issues: lint.issues,
    source,
    fingerprint: textFingerprint(text),
  });

  let repairReason: string | undefined;
  if (!lint.ok && source === "deepseek") {
    pipelineLog.snapshot(
      "repair.deterministic_input",
      text,
      "text_entering_deterministic_repair",
    );
    const repair = deterministicRepairPost(text, domainSlug);
    pipelineLog.step("repair.deterministic_result", {
      ok: repair.ok,
      reason: repair.ok ? null : repair.reason,
    });
    if (repair.ok) {
      pipelineLog.snapshot(
        "repair.deterministic_output",
        repair.text,
        "text_after_deterministic_repair",
      );
      text = repair.text;
      lint = lintLinkedInPost(text);
      pipelineLog.step("lint.after_deterministic_repair", {
        lintOk: lint.ok,
        issues: lint.issues,
        fingerprint: textFingerprint(text),
      });
      if (lint.ok && deepseekKey) {
        const finalReview = await reviewPostCoherence({
          postText: text,
        });
        pipelineLog.step("review.semantic_after_deterministic_repair", {
          coherent: finalReview.coherent,
          readable: finalReview.readable,
          professional: finalReview.professional,
          issues: finalReview.issues,
          passed:
            finalReview.coherent && finalReview.readable && finalReview.professional,
        });
        if (!finalReview.coherent || !finalReview.professional) {
          pipelineLog.step("pipeline.skip", {
            reason: "semantic_review_failed",
            issues: finalReview.issues,
          });
          return Response.json(
            {
              ok: false,
              reason: "semantic_review_failed" as const,
              error: "Deterministic repair output failed semantic review.",
              issues: finalReview.issues,
              lint,
              source,
              attempts: generationAttempts,
              skipped: true,
              model_used: resolvedLlmModel,
              model_output: text,
              run_id: runId,
              pipeline_trace: pipelineLog.trace,
            },
            { status: 422 },
          );
        }
      }
    } else {
      repairReason = repair.reason;
    }
  }
  if (!lint.ok) {
    const maxAttempts = resolveGenerationMaxAttempts();
    pipelineLog.step("pipeline.skip", {
      reason: repairReason ? "coherence_check_failed" : "max_retries_exhausted",
      repairReason: repairReason ?? null,
      lintIssues: lint.issues,
    });
    // Philosophy change: when DeepSeek's output is unsalvageable, we SKIP the
    // run rather than synthesize a publishable-but-incoherent post. The cost
    // of missing one cron is a fraction of the cost of putting word-salad in
    // front of the founders/CTOs we're trying to win.
    const reason = repairReason
      ? ("coherence_check_failed" as const)
      : ("max_retries_exhausted" as const);
    return Response.json(
      {
        ok: false,
        reason,
        error: repairReason
          ? `Skipped: deterministic repair could not produce a coherent post (${repairReason}).`
          : "Post rejected: does not meet LinkedIn rules (hashtags, word count, hook, etc.).",
        issues: lint.issues,
        lint,
        source,
        attempts: generationAttempts || maxAttempts,
        skipped: Boolean(repairReason),
        llm_error: llmError,
        // Diagnostic: confirms which model was actually used. Helps tell apart
        // "Flash is rambling" from "Pro is also rambling" when escalating.
        model_used: resolvedLlmModel,
        // Diagnostic: surface the full DeepSeek output (or template draft) when we
        // refuse to publish, so we can debug WHY the model is producing garbage.
        // Safe to expose because this endpoint is auth-gated by POST_API_SECRET.
        model_output: text,
        run_id: runId,
        pipeline_trace: pipelineLog.trace,
      },
      { status: 422 },
    );
  }

  const textToPost = applyOptionalPostNonce(text);

  const scheduledDueAtIso = postNow ? undefined : queueDueAtIso();

  // DRY_RUN: short-circuit before Buffer so we can validate the full pipeline
  // (DeepSeek → lint → repair → coherence check) without publishing anything.
  // Returns the would-be-posted text so we can eyeball quality across N runs.
  // Enable per-request with ?dryRun=true or globally with DRY_RUN=true.
  const dryRunActive = dryRun;
  if (dryRunActive) {
    pipelineLog.step("pipeline.dry_run_complete", { lintOk: lint.ok });
    return Response.json({
      ok: true,
      dry_run: true,
      source,
      buffer_now: postNow,
      scheduled_due_at: scheduledDueAtIso,
      lint,
      attempts: generationAttempts,
      llm_error: llmError,
      would_post: textToPost,
      run_id: runId,
      pipeline_trace: pipelineLog.trace,
    });
  }

  pipelineLog.step("buffer.request", {
    postNow,
    scheduledDueAtIso: scheduledDueAtIso ?? null,
    textChars: textToPost.length,
    fingerprint: textFingerprint(textToPost),
  });

  const gqlResult = await bufferCreatePostGraphql({
    apiKey: gqlKey,
    channelId: gqlChannel,
    text: textToPost,
    postNow,
    queueDueAt: scheduledDueAtIso,
  });

  if (!gqlResult.success) {
    const errMsg = gqlResult.message ?? "Buffer GraphQL create failed";
    pipelineLog.step("buffer.error", { error: errMsg });
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

  pipelineLog.step("pipeline.success", {
    bufferPostId: updateId,
    elapsedMs: Date.now() - runStartedAt,
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
    run_id: runId,
  });
}
