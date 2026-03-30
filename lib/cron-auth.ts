import { timingSafeEqual } from "crypto";

function toBuf(s: string): Buffer {
  return Buffer.from(s, "utf8");
}

export function verifyCronSecret(
  request: Request,
  expected: string | undefined,
): boolean {
  if (!expected || expected.length < 16) {
    return false;
  }

  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret") ?? "";
  const auth = request.headers.get("authorization") ?? "";
  const bearer =
    auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";

  const candidate = querySecret || bearer;
  if (!candidate) {
    return false;
  }

  try {
    const a = toBuf(candidate);
    const b = toBuf(expected);
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
