/**
 * Buffer Publish GraphQL API (replaces legacy api.bufferapp.com/1 for many accounts).
 * @see https://developers.buffer.com/
 */

import {
  immediateDueAtIso,
  queueDueAtIso,
} from "@/lib/buffer-schedule";

const DEFAULT_GRAPHQL_URL = "https://api.buffer.com/graphql";

function truncateForMessage(raw: string, max = 400): string {
  const oneLine = raw.trim().replace(/\s+/g, " ");
  if (oneLine.length <= max) {
    return oneLine;
  }
  return `${oneLine.slice(0, max)}…`;
}

/** PostActionPayload is only PostActionSuccess | MutationError (not VoidMutationError). */
const CREATE_POST_MUTATION = `
mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess {
      post {
        id
        text
      }
    }
    ... on MutationError {
      message
    }
  }
}`;

type GraphQLResponse = {
  data?: {
    createPost?: {
      __typename?: string;
      post?: { id?: string; text?: string };
      message?: string;
    };
  };
  errors?: Array<{ message: string }>;
};

export type BufferGraphqlCreateResult = {
  success: boolean;
  postId?: string;
  message?: string;
};

/**
 * schedulingType / mode match Buffer’s GraphQL schema; override via env if needed.
 */
function buildCreatePostInput(options: {
  text: string;
  channelId: string;
  postNow: boolean;
  /** When queued, optional precomputed ISO time (must match API response). */
  queueDueAt?: string;
}): Record<string, unknown> {
  const { text, channelId, postNow, queueDueAt } = options;

  const schedulingType =
    process.env.BUFFER_GRAPHQL_SCHEDULING_TYPE?.trim() || "automatic";
  const mode = process.env.BUFFER_GRAPHQL_POST_MODE?.trim() || "customScheduled";

  const dueAt = postNow
    ? immediateDueAtIso()
    : (queueDueAt ?? queueDueAtIso());

  return {
    text,
    channelId,
    schedulingType,
    mode,
    dueAt,
  };
}

export async function bufferCreatePostGraphql(options: {
  apiKey: string;
  channelId: string;
  text: string;
  postNow: boolean;
  /** Queued posts only: ISO time sent as CreatePostInput.dueAt */
  queueDueAt?: string;
  endpoint?: string;
}): Promise<BufferGraphqlCreateResult> {
  const {
    apiKey,
    channelId,
    text,
    postNow,
    queueDueAt,
    endpoint = process.env.BUFFER_GRAPHQL_URL?.trim() || DEFAULT_GRAPHQL_URL,
  } = options;

  const variables = {
    input: buildCreatePostInput({ text, channelId, postNow, queueDueAt }),
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: CREATE_POST_MUTATION,
      variables,
    }),
  });

  const raw = await res.text();

  let payload: GraphQLResponse;
  try {
    payload = JSON.parse(raw) as GraphQLResponse;
  } catch {
    return {
      success: false,
      message: `Buffer GraphQL HTTP ${res.status} (non-JSON). ${truncateForMessage(raw)}`,
    };
  }

  if (payload.errors?.length) {
    return {
      success: false,
      message: payload.errors.map((e) => e.message).join("; "),
    };
  }

  const node = payload.data?.createPost;
  if (!node) {
    return {
      success: false,
      message: "Buffer GraphQL: missing data.createPost",
    };
  }

  if (node.__typename === "PostActionSuccess" && node.post?.id) {
    return { success: true, postId: node.post.id };
  }

  const errMsg =
    typeof node.message === "string" ? node.message : node.__typename;
  return {
    success: false,
    message: errMsg
      ? `Buffer createPost: ${errMsg}`
      : "Buffer createPost: unknown failure",
  };
}
