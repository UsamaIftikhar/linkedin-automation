export const POST_TYPES = [
  "case_study",
  "lesson_learned",
  "technical_breakdown",
  "mistake_and_fix",
  "architecture_explained",
  "devops_tip",
  "scaling_story",
  "simple_explainer",
  "engineering_judgment",
] as const;

export type PostType = (typeof POST_TYPES)[number];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function pickPostType(runEntropy: string): PostType {
  const idx = hashString(`${runEntropy}|posttype`) % POST_TYPES.length;
  return POST_TYPES[idx]!;
}

export function postTypeGuidance(type: PostType): string {
  const map: Record<PostType, string> = {
    case_study: "Write as a real implementation story: context, what you built, one concrete detail, outcome.",
    lesson_learned: "Write as an insight from experience: what you believed, what happened, what you do now.",
    technical_breakdown: "Explain a system or concept clearly for engineers: components, flow, one non-obvious detail.",
    mistake_and_fix: "Describe a problem you saw or made, the failure mode, and the fix with a specific technical angle.",
    architecture_explained: "System design angle: constraints, choices, tradeoffs, how pieces connect.",
    devops_tip: "Practical infra or deployment advice: pipelines, observability, releases, or reliability.",
    scaling_story: "Growth or performance: load, bottlenecks, what you changed in the stack or process.",
    simple_explainer: "Teach the idea in simple terms without dumbing it down: when to use it, when not to, and the key tradeoff.",
    engineering_judgment: "Write like an experienced engineer making decisions under constraints: clear opinion, tradeoffs, practical reasoning, no fluff.",
  };
  return map[type];
}
