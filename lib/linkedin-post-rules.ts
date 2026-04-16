/**
 * LinkedIn / Buffer-friendly constraints (feed posts).
 * @see https://www.linkedin.com/help/linkedin/answer/a13385634
 */

const DEFAULT_MAX_CHARS = 3000;

export const DOMAIN_FOCUS = [
  "backend",
  "devops",
  "aws",
  "serverless",
  "iot",
  "databases",
  "system_design",
  "ci_cd",
  "monitoring",
  "ai_integration",
  "frontend",
  "platforms",
  "llm_ops",
  "automation",
] as const;

export type DomainFocusSlug = (typeof DOMAIN_FOCUS)[number];

const DOMAIN_BLURB: Record<DomainFocusSlug, string> = {
  backend: "APIs, PostgreSQL, Supabase, authentication, event-driven systems",
  devops: "CI/CD, deployments, automation, environments, release discipline",
  aws: "EC2, Lambda, VPC, IAM, core AWS services and patterns",
  serverless: "Functions, event sources, cold starts, limits, operational model",
  iot: "AWS IoT Core, MQTT, telemetry, devices, edge-to-cloud paths",
  databases: "PostgreSQL, schema, queries, migrations, data modeling",
  system_design: "Tradeoffs, boundaries, scalability, failure modes",
  ci_cd: "Pipelines, tests, gates, branching, delivery cadence",
  monitoring: "Logs, metrics, alerts, SLOs, incident signals",
  ai_integration: "RAG, model APIs, prompt patterns, data pipelines for ML",
  frontend: "Next.js, React, TypeScript, rendering, state, performance, UI architecture",
  platforms: "DigitalOcean, Railway, Vercel, managed services, deployment tradeoffs",
  llm_ops: "Ollama, Mistral, DeepSeek, NVIDIA/NIM, model serving, inference workflows",
  automation: "Python functions, external cron jobs, cron-job.org, scheduled workflows, orchestration",
};

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function pickDomainFocusForRun(runEntropy: string): DomainFocusSlug {
  const idx = hashString(`${runEntropy}|domain`) % DOMAIN_FOCUS.length;
  return DOMAIN_FOCUS[idx]!;
}

export function domainFocusForPrompt(slug: DomainFocusSlug): string {
  return `${slug.replace(/_/g, " ")} — ${DOMAIN_BLURB[slug]}`;
}

function maxChars(): number {
  const n = Number(process.env.LINKEDIN_MAX_CHARS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CHARS;
}

function wordBounds(): { min: number; max: number } {
  const min = Number(process.env.POST_WORD_MIN);
  const max = Number(process.env.POST_WORD_MAX);
  return {
    min: Number.isFinite(min) && min > 0 ? min : 90,
    max: Number.isFinite(max) && max > 0 ? max : 220,
  };
}

function hashtagBounds(): { min: number; max: number } {
  const min = Number(process.env.POST_HASHTAG_MIN);
  const max = Number(process.env.POST_HASHTAG_MAX);
  return {
    min: Number.isFinite(min) && min >= 0 ? min : 5,
    max: Number.isFinite(max) && max > 0 ? max : 10,
  };
}

/** Broad technical signals (prose is lowercased before check). */
const TECH_KEYWORDS = [
  "aws",
  "lambda",
  "ec2",
  "mqtt",
  "ci/cd",
  "cicd",
  "pipeline",
  "postgres",
  "postgresql",
  "supabase",
  "api",
  "apis",
  "docker",
  "k8s",
  "terraform",
  "vpc",
  "iot",
  "telemetry",
  "serverless",
  "redis",
  "kafka",
  "s3",
  "dynamodb",
  "graphql",
  "rag",
  "prompt",
  "kubernetes",
  "github actions",
  "gitlab",
  "observability",
  "prometheus",
  "grafana",
  "cloudwatch",
  "sqs",
  "sns",
  "event-driven",
  "microservice",
  "load balancer",
  "autoscaling",
  "digitalocean",
  "railway",
  "vercel",
  "frontend",
  "next.js",
  "react",
  "typescript",
  "bitbucket pipelines",
  "ollama",
  "mistral",
  "deepseek",
  "nvidia",
  "nim",
  "python",
  "n8n",
  "clickup",
  "slack",
  "slack events",
  "webhook",
  "webhooks",
  "stripe",
  "payment intent",
  "escrow",
  "vector db",
  "vector database",
  "hugging face",
  "claude",
  "zoho",
  "smtp",
  "ats",
  "react native",
  "elevenlabs",
  "transcription",
  "cron-job.org",
  "cron job",
  "scheduled",
];

export function hasTechnicalDepth(prose: string): boolean {
  const t = prose.toLowerCase();
  return TECH_KEYWORDS.some((k) => t.includes(k.toLowerCase()));
}

/** At least one concrete product/pattern name (not vague "ingest workers"). */
const NAMED_STACK_HINTS = [
  "iot core",
  "kinesis",
  "lambda",
  "dynamodb",
  "postgres",
  "postgresql",
  "rds",
  "github actions",
  "gitlab",
  "api gateway",
  "cloudwatch",
  "eventbridge",
  "step functions",
  "fargate",
  "ecs",
  "sqs",
  "sns",
  "amazon s3",
  "s3 bucket",
  "ec2",
  "vpc",
  "eks",
  "alb",
  "nlb",
  "mqtt",
  "supabase",
  "redis",
  "kafka",
  "grafana",
  "prometheus",
  "terraform",
  "kubernetes",
  "docker",
  "open telemetry",
  "otel",
  "datadog",
  "digitalocean",
  "railway",
  "vercel",
  "bitbucket pipelines",
  "bitbucket",
  "next.js",
  "react",
  "typescript",
  "ollama",
  "mistral",
  "deepseek",
  "nvidia nim",
  "nvidia",
  "python",
  "n8n",
  "clickup",
  "slack events api",
  "slack webhook",
  "stripe",
  "payment intent",
  "payment hold",
  "vector db",
  "pinecone",
  "weaviate",
  "qdrant",
  "hugging face",
  "claude",
  "zoho smtp",
  "zoho",
  "smtp",
  "ats",
  "react native",
  "elevenlabs",
  "deepseek",
  "cron-job.org",
  "cronjob",
] as const;

export function hasNamedStackDetail(prose: string): boolean {
  const t = prose.toLowerCase();
  return NAMED_STACK_HINTS.some((hint) => t.includes(hint));
}

/** Blocks sales/procurement framing; posts should read as hands-on engineering. */
export function hasNonTechnicalFraming(prose: string): string | null {
  const t = prose.toLowerCase();
  if (/\bprocurement\b/.test(t)) {
    return "Avoid procurement / buying-process framing; focus on systems you build or operate.";
  }
  if (/\bstatement of work\b/.test(t) || /\bsow\b/.test(t)) {
    return "Avoid SOW / statement-of-work language; describe technical work and architecture instead.";
  }
  if (/\bpaid discovery\b/.test(t) || /\bgo\/no-go\b/.test(t)) {
    return "Avoid commercial discovery / go-no-go sales language; stay in implementation and engineering tradeoffs.";
  }
  if (/\banother round of decks\b/.test(t) || /\bsales promises\b/.test(t)) {
    return "Avoid generic business / sales narrative; anchor in concrete engineering (AWS, CI/CD, APIs, data, IoT).";
  }
  return null;
}

const OVER_POLISHED_PHRASES = [
  "single, authoritative path",
  "authoritative path",
  "tight feedback loop",
  "paradigm shift",
  "best-in-class",
  "world-class",
  "seamless",
  "robust solution",
  "core issue was",
  "key operational detail",
] as const;

export function hasOverPolishedPhrasing(prose: string): string | null {
  const t = prose.toLowerCase();
  const hit = OVER_POLISHED_PHRASES.find((phrase) => t.includes(phrase));
  if (hit) {
    return `Phrase sounds too polished or corporate ("${hit}"). Rewrite in simpler engineering language.`;
  }
  if (/turns?\s+[^.]{0,40}\s+into\s+[^.]{0,40}/i.test(prose)) {
    return "Closing sounds slogan-like ('turns X into Y'). Prefer a plainer takeaway.";
  }
  return null;
}

export function hasDenseParagraph(prose: string): string | null {
  const paragraphs = prose
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const paragraph of paragraphs) {
    const words = countWords(paragraph);
    const sentenceCount = paragraph
      .split(/[.!?]+/)
      .map((part) => part.trim())
      .filter(Boolean).length;
    if (words > 70 || sentenceCount > 4) {
      return "A paragraph is too dense. Split long blocks into shorter paragraphs or bullets.";
    }
  }
  return null;
}

export function hasStrongHook(prose: string): boolean {
  const lines = prose.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const first = (lines[0] ?? "").toLowerCase();
  if (!first) {
    return false;
  }
  const firstWords = first.split(/\s+/).filter(Boolean);
  if (firstWords.length <= 16 && /[.!?]$/.test(first)) {
    return true;
  }
  const openingParagraph = lines.slice(0, 2).join(" ").toLowerCase();
  const openingWordCount = countWords(openingParagraph);
  const openingHasTechSignal = TECH_KEYWORDS.some((keyword) =>
    openingParagraph.includes(keyword.toLowerCase()),
  );
  const openingHasTension =
    /\b(kept|hitting|hit|broke|breaks|failed|failure|stall|stalled|drift|drifted|surprise|surprises|spike|spiked|latency|cost|slow|rollback|retry|incident|problem|issue|mismatch|constraint|overload)\b/.test(
      openingParagraph,
    );
  if (
    openingWordCount <= 36 &&
    /[.!?]$/.test(openingParagraph) &&
    (openingHasTension || (openingHasTechSignal && /^(i|we)\b/.test(openingParagraph)))
  ) {
    return true;
  }
  if (
    openingWordCount <= 28 &&
    /[.!?]$/.test(openingParagraph) &&
    (
      openingParagraph.includes("production") ||
      openingParagraph.includes("deploy") ||
      openingParagraph.includes("release") ||
      openingParagraph.includes("latency") ||
      openingParagraph.includes("cost") ||
      openingParagraph.includes("pipeline") ||
      openingParagraph.includes("scaling") ||
      openingParagraph.includes("drift") ||
      openingParagraph.includes("surprise") ||
      openingParagraph.includes("trade-off") ||
      openingParagraph.includes("tradeoff")
    )
  ) {
    return true;
  }
  return (
    first.includes("kept hitting") ||
    first.includes("too many") ||
    first.includes("surprise") ||
    first.includes("mistake") ||
    first.includes("problem") ||
    first.includes("issue") ||
    first.includes("learned") ||
    first.includes("one thing") ||
    first.includes("why ") ||
    first.includes("how ") ||
    first.includes("never ") ||
    first.includes("stopped") ||
    first.includes("avoid") ||
    first.includes("fixed") ||
    first.includes("wrong") ||
    first.includes("failed") ||
    first.includes("realized") ||
    first.includes("truth") ||
    first.includes("ran ") ||
    first.includes("here's ") ||
    first.includes("here’s ") ||
    first.includes("honest ") ||
    first.includes("lesson") ||
    first.includes("device") ||
    first.includes("telemetry") ||
    first.includes("under load") ||
    first.includes("in one ") ||
    first.startsWith("most ") ||
    first.startsWith("after ") ||
    first.startsWith("alongside ") ||
    first.startsWith("when ") ||
    first.startsWith("aws ") ||
    first.includes("?")
  );
}

export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

/**
 * Treat trailing line(s) that contain only hashtags as the tag block; word count applies to prose above.
 */
export function splitProseAndHashtagBlock(text: string): {
  prose: string;
  tagBlock: string;
} {
  const lines = text.trimEnd().split(/\n/);
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1]!.trim();
    if (!line) {
      end -= 1;
      continue;
    }
    const words = line.split(/\s+/).filter(Boolean);
    if (
      words.length === 0 ||
      !words.every((w) => /^#[A-Za-z][A-Za-z0-9_]*$/.test(w))
    ) {
      break;
    }
    end -= 1;
  }
  const prose = lines.slice(0, end).join("\n").trim();
  const tagBlock = lines.slice(end).join("\n").trim();
  return { prose, tagBlock };
}

/** LinkedIn-style hashtags: #Word, #Word_Sub */
export function extractHashtags(text: string): string[] {
  const re = /#[A-Za-z][A-Za-z0-9_]*/g;
  return text.match(re) ?? [];
}

export type PostLintResult = {
  ok: boolean;
  issues: string[];
  wordCount: number;
  hashtagCount: number;
  charCount: number;
};

/** Character cap only (template-only debugging path). */
export function lintLinkedInCharLimit(text: string): PostLintResult {
  const charCount = [...text].length;
  const cap = maxChars();
  const issues: string[] = [];
  if (charCount > cap) {
    issues.push(`Body exceeds ${cap} characters (${charCount}).`);
  }
  const { prose, tagBlock } = splitProseAndHashtagBlock(text);
  return {
    ok: issues.length === 0,
    issues,
    wordCount: countWords(prose),
    hashtagCount: extractHashtags(tagBlock.length > 0 ? tagBlock : text).length,
    charCount,
  };
}

/** Full rules for generated posts (Buffer → LinkedIn). */
export function lintLinkedInPost(text: string): PostLintResult {
  const issues: string[] = [];
  const charCount = [...text].length;
  const { prose, tagBlock } = splitProseAndHashtagBlock(text);
  const wordCount = countWords(prose);
  const tags = extractHashtags(tagBlock.length > 0 ? tagBlock : text);
  const hashtagCount = tags.length;

  const { min: wMin, max: wMax } = wordBounds();
  const { min: hMin, max: hMax } = hashtagBounds();
  const cap = maxChars();

  if (charCount > cap) {
    issues.push(`Body exceeds ${cap} characters (${charCount}); shorten for LinkedIn/Buffer.`);
  }
  if (wordCount < wMin || wordCount > wMax) {
    issues.push(
      `Word count ${wordCount} is outside ${wMin}–${wMax} (prose only; set POST_WORD_MIN / POST_WORD_MAX).`,
    );
  }
  if (hashtagCount < hMin) {
    issues.push("Missing hashtags");
  } else if (hashtagCount > hMax) {
    issues.push(
      `Hashtag count ${hashtagCount} exceeds maximum ${hMax} (use ${hMin}–${hMax} tags on final line(s) only).`,
    );
  } else if (hashtagCount > 0 && !tagBlock.trim()) {
    issues.push(
      "Put all hashtags on dedicated final line(s): each line must contain only space-separated #hashtags (Buffer/LinkedIn formatting).",
    );
  }

  if (!hasStrongHook(prose)) {
    issues.push(
      "Weak hook: open with a problem, mistake, lesson, why/how question, or sharp insight in the first line.",
    );
  }
  if (!hasNamedStackDetail(prose)) {
    issues.push(
      "Name at least one concrete stack element in prose (e.g. AWS IoT Core rule → Kinesis → Lambda, Postgres idempotency key, GitHub Actions job on main). Vague phrases like 'ingest workers' or 'the pipeline' alone are not enough.",
    );
  }

  const framing = hasNonTechnicalFraming(prose);
  if (framing) {
    issues.push(framing);
  }

  const polished = hasOverPolishedPhrasing(prose);
  if (polished) {
    issues.push(polished);
  }

  const density = hasDenseParagraph(prose);
  if (density) {
    issues.push(density);
  }

  return {
    ok: issues.length === 0,
    issues,
    wordCount,
    hashtagCount,
    charCount,
  };
}
