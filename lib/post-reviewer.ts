export type ReviewResult = {
  coherent: boolean;
  readable: boolean;
  professional: boolean;
  issues: string[];
};

export async function reviewPostCoherence(options: {
  apiKey: string;
  baseUrl?: string;
  model: string;
  postText: string;
  signal?: AbortSignal;
}): Promise<ReviewResult> {
  const {
    apiKey,
    baseUrl = "https://api.deepseek.com",
    model,
    postText,
    signal,
  } = options;
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  const systemPrompt = `You are a strict quality reviewer for LinkedIn posts. You will receive a post draft. Read EVERY sentence carefully and judge whether it actually means something a human wrote intentionally.

Respond with ONLY valid JSON, no markdown, no preamble:
{
  "coherent": boolean,
  "readable": boolean,
  "professional": boolean,
  "issues": ["specific problems found"]
}

Set "coherent": false if ANY sentence is word-salad, grammatically broken, trails off, or does not parse as a real English sentence. Examples of incoherent text that MUST score coherent:false — "none is alive beside view to always reading load count", "automated stops securely progress into make monitoring growth faster". Set "professional": false if publishing this would embarrass a senior engineer. Be strict — when in doubt, fail it.`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: 400,
      thinking: { type: "disabled" },
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: postText },
      ],
    }),
    signal,
  });

  let data: {
    choices?: Array<{ message?: { content?: string } }>;
  };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return {
      coherent: false,
      readable: false,
      professional: false,
      issues: ["reviewer returned non-JSON response — failing closed"],
    };
  }

  const raw = data?.choices?.[0]?.message?.content?.trim() ?? "";
  const cleaned = raw.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(cleaned) as {
      coherent?: boolean;
      readable?: boolean;
      professional?: boolean;
      issues?: unknown;
    };
    return {
      coherent: parsed.coherent === true,
      readable: parsed.readable === true,
      professional: parsed.professional === true,
      issues: Array.isArray(parsed.issues)
        ? parsed.issues.filter((i): i is string => typeof i === "string")
        : [],
    };
  } catch {
    return {
      coherent: false,
      readable: false,
      professional: false,
      issues: ["reviewer returned unparseable JSON — failing closed"],
    };
  }
}
