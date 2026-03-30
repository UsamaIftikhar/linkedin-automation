type GraphQLError = { message: string };

type CreateIdeaData = {
  data?: {
    createIdea?: {
      id?: string;
      content?: { title?: string; text?: string };
    } | null;
  };
  errors?: GraphQLError[];
};

const MUTATION = `
mutation CreateIdea($input: CreateIdeaInput!) {
  createIdea(input: $input) {
    ... on Idea {
      id
      content {
        title
        text
      }
    }
  }
}`;

export function titleFromPostBody(body: string, maxLen = 120): string {
  const line =
    body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "LinkedIn post";
  if (line.length <= maxLen) {
    return line;
  }
  return `${line.slice(0, Math.max(0, maxLen - 1))}…`;
}

/**
 * Optional: register the same copy as an "Idea" in your GraphQL backend.
 * Requires GRAPHQL_IDEAS_URL, GRAPHQL_IDEAS_TOKEN, IDEAS_ORGANIZATION_ID.
 */
function authHeaders(
  token: string,
  mode: string | undefined,
): Record<string, string> {
  const m = (mode ?? "bearer").toLowerCase();
  if (m === "apikey" || m === "x-api-key") {
    return { "x-api-key": token };
  }
  return { Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}` };
}

export async function createIdeaViaGraphql(options: {
  endpoint: string;
  token: string;
  organizationId: string;
  title: string;
  text: string;
  authMode?: string;
}): Promise<{ ok: true; id?: string } | { ok: false; message: string }> {
  const { endpoint, token, organizationId, title, text, authMode } = options;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token, authMode),
    },
    body: JSON.stringify({
      query: MUTATION,
      variables: {
        input: {
          organizationId,
          content: { title, text },
        },
      },
    }),
  });

  let payload: CreateIdeaData;
  try {
    payload = (await res.json()) as CreateIdeaData;
  } catch {
    return { ok: false, message: `Ideas GraphQL: not JSON (HTTP ${res.status})` };
  }

  if (payload.errors?.length) {
    return {
      ok: false,
      message: payload.errors.map((e) => e.message).join("; "),
    };
  }

  const id = payload.data?.createIdea?.id;
  return { ok: true, id };
}
