import { randomUUID } from "crypto";

import pillarsData from "@/data/pillars.json";

export type Pillar = {
  id: string;
  /** Who this is for (role/industry) */
  audience?: string;
  /** The pain or situation */
  problem: string;
  /** Why it keeps happening */
  persists?: string;
  /** How you think about fixing it */
  principle: string;
  /** Soft CTA line */
  cta: string;
};

const BANNED_SUBSTRINGS = [
  "in today's world",
  "in today’s world",
  "leverage ",
  " unlock",
  "game-changer",
  "synergy",
  " delve",
  "landscape",
  "cutting-edge",
  "here's the thing",
  "here’s the thing",
  "let that sink in",
  "procurement",
  "statement of work",
  "paid discovery",
  "go/no-go",
] as const;

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function createDeterministicRandom(seed: string) {
  let value = 0;
  for (let i = 0; i < seed.length; i += 1) {
    value = (value * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return function () {
    value = (value * 1664525 + 1013904223) >>> 0;
    return (value & 0x7fffffff) / 0x80000000;
  };
}

function choose<T>(items: readonly T[], rand: () => number): T {
  return items[Math.floor(rand() * items.length)];
}

function chooseOptional<T>(items: readonly T[], rand: () => number, probability = 0.45): T | null {
  return rand() < probability ? choose(items, rand) : null;
}

const leadLines = [
  "A frequent mistake is",
  "What I keep seeing is",
  "Too often teams believe",
  "It is easy to miss that",
  "A common trap is",
  "On most projects I audit,",
  "Honest lesson:",
  "Reality check:",
  "Ran into this again:",
];

const persistenceStarts = [
  "That happens because",
  "It keeps happening when",
  "The underlying issue is that",
  "It usually persists because",
  "What makes it so hard is",
  "The pattern behind it:",
];

/** Colon openers avoid broken grammar with principles that start with a verb ("Define…", "Route…"). */
const strategyOpeners = [
  "My approach",
  "What I ship first",
  "The move that worked",
  "Concrete starting point",
  "In practice",
];

function strategyLine(rand: () => number, principle: string): string {
  return `${choose(strategyOpeners, rand)}: ${principle}`;
}

const outcomeLines = [
  "which gets a real build into an environment you can measure instead of debating abstractions.",
  "so the next deploy carries less guesswork and easier rollback.",
  "which turns vague risk into something you can observe in metrics and logs.",
  "so the team ships smaller slices with clearer ownership of the system boundary.",
  "and the pipeline—not a slide deck—becomes the proof that the change is safe.",
  "making it easier to iterate on the actual service, database, or infra path.",
];

const contextLines = [
  "This matters because production behavior diverges when the path to deploy is fuzzy.",
  "That same gap is what makes on-call painful when telemetry does not match what shipped.",
  "In practice, this often burns more calendar time than the technical work itself.",
  "Once that is fixed, you can reason about load, failures, and schema changes with data.",
  "It also changes whether you can trust your CI signal before you cut a release.",
];

const bulletAdditions = [
  "the contract between services is implicit until something breaks in integration",
  "people optimize for meetings instead of measurable deploy health",
  "the strongest signal is in logs and metrics, but nobody wired them to alerts",
  "environments drift because config and migrations are not applied the same way twice",
  "the team confuses shipping tasks with validating the data path end-to-end",
];

const summaryLines = [
  "That rarely needs a big redesign — it needs a tighter technical slice you can run.",
  "The hardest part is choosing what to validate first in the real stack.",
  "The change is small; making it repeatable in CI and prod is what most teams miss.",
  "A small shift in how you deploy and observe beats another planning cycle.",
  "The next release feels calmer when the pipeline and dashboards tell the same story.",
];

const issueSectionLabels = [
  "What usually goes wrong",
  "Where teams get stuck",
  "The pattern behind it",
  "What keeps breaking",
] as const;

const tradeoffLines = [
  "The trade-off is accepting a little more upfront structure so failures show up earlier in the real stack.",
  "The trade-off is a bit more operational discipline in exchange for fewer surprises at deploy time.",
  "The trade-off is slightly slower iteration at first, but much clearer signals once the system is live.",
  "The trade-off is taking on some implementation complexity now so scaling and debugging stay predictable later.",
] as const;

function addOptionalClosing(lines: string[], rand: () => number) {
  const optionalContext = chooseOptional(contextLines, rand, 0.55);
  const optionalSummary = chooseOptional(summaryLines, rand, 0.55);

  if (optionalContext) {
    lines.push("");
    lines.push(optionalContext);
  }

  if (optionalSummary) {
    lines.push("");
    lines.push(optionalSummary);
  }
}

/**
 * Each `runEntropy` value (default: new UUID per call) picks pillar, layout, and phrasing.
 */
export function pickPillarAndFormat(
  date: Date,
  runEntropy: string,
): {
  pillar: Pillar;
  formatIndex: number;
  rand: () => number;
} {
  const pillars = pillarsData as Pillar[];
  if (!pillars.length) {
    throw new Error("No pillars configured in data/pillars.json");
  }

  const pillar = pillars[hashString(runEntropy) % pillars.length];
  const formatIndex = hashString(`${runEntropy}|layout`) % 10;
  const seed = `${runEntropy}|${pillar.id}|${formatIndex}|${date.toISOString()}`;
  const rand = createDeterministicRandom(seed);

  return { pillar, formatIndex, rand };
}

function audienceSuffix(p: Pillar): string {
  return p.audience?.trim() ? ` (${p.audience.trim()})` : "";
}

function buildFromTemplate(pillar: Pillar, formatIndex: number, rand: () => number): string {
  const a = audienceSuffix(pillar);
  const persists = pillar.persists?.trim() ||
    "Teams often optimize for the wrong milestone, so the real constraint never gets addressed.";

  const lines: string[] = [];
  const problemLine = pillar.problem.replace(/\.$/, "");

  switch (formatIndex) {
    case 0: {
      lines.push(`${choose(leadLines, rand)} ${pillar.problem}${a}.`);
      lines.push("");
      lines.push(`${choose(persistenceStarts, rand)} ${persists}.`);
      lines.push("");
      lines.push(`${strategyLine(rand, pillar.principle)}.`);
      lines.push(`${choose(outcomeLines, rand)}`);
      break;
    }

    case 1: {
      lines.push(`I see this clearly when ${pillar.problem.toLowerCase().replace(/\.$/, "")}${a}.`);
      lines.push("");
      lines.push("What usually goes wrong:");
      lines.push(`- ${persists}.`);
      lines.push(`- ${choose(bulletAdditions, rand)}`);
      lines.push("");
      lines.push(`${strategyLine(rand, pillar.principle)}.`);
      break;
    }

    case 2: {
      lines.push(`Common mistake: treating "${pillar.problem.replace(/\.$/, "")}" as a process issue.${a}`);
      lines.push("");
      lines.push(`Reality: ${persists}.`);
      lines.push("");
      lines.push(`${strategyLine(rand, pillar.principle)}.`);
      lines.push(`${choose(outcomeLines, rand)}`);
      break;
    }

    case 3: {
      lines.push(`If your team still struggles because ${pillar.problem.toLowerCase().replace(/\.$/, "")}${a},`);
      lines.push("");
      lines.push(`${choose(persistenceStarts, rand)} ${persists}.`);
      lines.push("");
      lines.push(`${strategyLine(rand, pillar.principle)}.`);
      break;
    }

    case 4: {
      lines.push(`The hardest part is that ${persists.toLowerCase()}`);
      lines.push("");
      lines.push(`${strategyLine(rand, pillar.principle)}.`);
      lines.push(`${choose(outcomeLines, rand)}`);
      break;
    }

    case 5: {
      lines.push(`I keep seeing ${pillar.problem.toLowerCase().replace(/\.$/, "")}${a}.`);
      lines.push("");
      lines.push(`${choose(persistenceStarts, rand)} ${persists}.`);
      lines.push("");
      lines.push(`${strategyLine(rand, pillar.principle)}.`);
      lines.push(`${choose(outcomeLines, rand)}`);
      break;
    }

    case 7: {
      lines.push(`Most teams do not struggle because the stack is weak. They struggle because ${problemLine.toLowerCase()}${a}.`);
      lines.push("");
      lines.push(`${choose(issueSectionLabels, rand)}:`);
      lines.push(`- ${persists}.`);
      lines.push(`- ${choose(bulletAdditions, rand)}.`);
      lines.push("");
      lines.push("What I do now:");
      lines.push(`- ${pillar.principle}.`);
      break;
    }

    case 8: {
      lines.push(`Architecture gets clearer once you stop treating "${problemLine}" as an abstract planning issue${a}.`);
      lines.push("");
      lines.push("What changed:");
      lines.push(`${choose(persistenceStarts, rand)} ${persists}.`);
      lines.push("");
      lines.push("The implementation move:");
      lines.push(`${pillar.principle}.`);
      lines.push("");
      lines.push(`The trade-off: ${choose(tradeoffLines, rand).toLowerCase()}`);
      break;
    }

    case 9: {
      lines.push(`Most engineering problems are decision problems before they become scaling problems${a}.`);
      lines.push("");
      lines.push(`I keep coming back to this when ${problemLine.toLowerCase()}.`);
      lines.push("");
      lines.push("The signal I trust:");
      lines.push(`- ${persists}.`);
      lines.push(`- ${pillar.principle}.`);
      break;
    }

    default: {
      const hookLead = choose(
        [
          `What bit us in prod: ${problemLine.toLowerCase()}${a}.`,
          `Lesson from the field: ${problemLine.toLowerCase()}${a}.`,
          `I keep seeing ${problemLine.toLowerCase()}${a}.`,
          `Ships stall when ${problemLine.toLowerCase()}${a}.`,
        ],
        rand,
      );
      lines.push(hookLead);
      lines.push("");
      lines.push(`${choose(persistenceStarts, rand)} ${persists}.`);
      lines.push("");
      lines.push(`${strategyLine(rand, pillar.principle)}.`);
      lines.push(`${choose(outcomeLines, rand)}`);
      break;
    }
  }

  addOptionalClosing(lines, rand);

  lines.push("");
  lines.push(pillar.cta);

  if (process.env.ALLOW_TEMPLATE_PUBLISH === "true") {
    lines.push("");
    lines.push(
      "#AWS #DevOps #BackendDevelopment #SoftwareEngineering #CloudArchitecture #CICD",
    );
  }

  return lines.join("\n");
}

/** Human-readable names for `formatIndex` values (matches `buildFromTemplate` branches). */
export const FORMAT_TEMPLATE_KEYS = [
  "lead_persistence_strategy_outcome",
  "isee_bullets_strategy",
  "common_mistake_reality_strategy",
  "if_team_struggles",
  "hardest_part_strategy_outcome",
  "keep_seeing_strategy_outcome",
  "one_strong_signal",
  "sections_and_bullets",
  "architecture_breakdown",
  "engineering_judgment",
] as const;

export function formatTemplateLabel(formatIndex: number): string {
  const i = ((formatIndex % FORMAT_TEMPLATE_KEYS.length) + FORMAT_TEMPLATE_KEYS.length) %
    FORMAT_TEMPLATE_KEYS.length;
  return FORMAT_TEMPLATE_KEYS[i] ?? "unknown";
}

export function formatTemplateGuidance(formatIndex: number): string {
  switch (formatTemplateLabel(formatIndex)) {
    case "isee_bullets_strategy":
    case "sections_and_bullets":
      return "Prefer short paragraphs plus 2-4 hyphen bullets. Use scannable labels when helpful.";
    case "architecture_breakdown":
      return "Use compact explanatory sections such as 'What changed', 'Architecture overview', or 'The trade-off'.";
    case "engineering_judgment":
      return "Lead with a clear opinion or principle, then explain the engineering reasoning with concise paragraphs or bullets.";
    default:
      return "Use short, readable paragraphs. Keep the layout natural and scannable instead of one dense block.";
  }
}

export type DraftPostResult = {
  text: string;
  pillarId: string;
  formatIndex: number;
  formatKey: string;
  formatGuidance: string;
};

/**
 * Builds a new post. Each invocation uses a fresh `runId` so copy differs every API hit.
 * Pass a fixed `runId` only if you need reproducible output (e.g. tests).
 */
export function buildDraftPost(
  date = new Date(),
  runId: string = randomUUID(),
): DraftPostResult {
  const { pillar, formatIndex, rand } = pickPillarAndFormat(date, runId);
  const text = buildFromTemplate(pillar, formatIndex, rand);
  return {
    text,
    pillarId: pillar.id,
    formatIndex,
    formatKey: formatTemplateLabel(formatIndex),
    formatGuidance: formatTemplateGuidance(formatIndex),
  };
}

export function lintBannedPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const b of BANNED_SUBSTRINGS) {
    if (lower.includes(b)) {
      hits.push(b);
    }
  }
  return hits;
}
