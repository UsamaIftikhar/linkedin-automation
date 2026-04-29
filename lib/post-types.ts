export const POST_TYPES = [
  "founder_problem_solved",
  "before_after_build",
  "client_result_story",
  "hot_take",
  "lesson_learned",
  "mistake_and_fix",
  "tool_tradeoff",
  "scaling_story",
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
    founder_problem_solved:
      "Write from the perspective of solving a real business problem for a client or your own product. Start with the business pain, not the technical solution. Show what was at stake. End with what changed.",
    before_after_build:
      "Show a concrete transformation: what existed before, what you changed, and the measurable result. Use real numbers or specific technical details. Never use vague words like 'improved' without saying how much.",
    client_result_story:
      "Tell a real story about delivering something for a client or shipping a real product. Include one moment where something nearly went wrong. Show how you handled it. Make a founder think: I want someone like this.",
    hot_take:
      "State a clear, specific opinion that challenges a common assumption in software development or AI. Back it with one real example from your own experience. Invite disagreement politely at the end.",
    lesson_learned:
      "Write as a genuine insight from experience. Start with what you believed before. Describe what happened that changed your thinking. State what you do differently now. Be specific — no generic advice.",
    mistake_and_fix:
      "Describe a real mistake, the failure mode, and the specific fix. Do not be vague. Name the technology, the symptom, and the root cause. Founders and CTOs trust developers who admit mistakes and explain how they fixed them.",
    tool_tradeoff:
      "Compare two approaches, tools, or architectural decisions based on real production experience. Do not declare a winner — explain the tradeoff and when each applies. Show you have used both.",
    scaling_story:
      "Describe a real performance or growth bottleneck and how you diagnosed and fixed it. Include one specific metric: latency, error rate, cost, or throughput. Show the before and after.",
    engineering_judgment:
      "Write like a senior engineer making a hard decision under constraints. State the constraint clearly. Show the options considered. Explain the choice and what it cost. No fluff — just clear reasoning a CTO would respect.",
  };
  return map[type];
}
