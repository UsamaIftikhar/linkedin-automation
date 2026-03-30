import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

export type PostMemoryEntry = {
  domain: string;
  postType: string;
  at: string;
};

type MemoryFile = { entries: PostMemoryEntry[] };

const MAX_ENTRIES = 10;

function memoryFilePath(): string {
  if (process.env.POST_MEMORY_PATH?.trim()) {
    return process.env.POST_MEMORY_PATH.trim();
  }
  if (process.env.VERCEL) {
    return "/tmp/linkedin-post-memory.json";
  }
  return path.join(process.cwd(), "data", "post-memory.json");
}

export async function loadPostMemory(): Promise<PostMemoryEntry[]> {
  if (process.env.POST_MEMORY_DISABLED === "true") {
    return [];
  }
  const p = memoryFilePath();
  try {
    const raw = await readFile(p, "utf8");
    const j = JSON.parse(raw) as MemoryFile;
    return Array.isArray(j.entries) ? j.entries : [];
  } catch {
    return [];
  }
}

export async function appendPostMemory(entry: PostMemoryEntry): Promise<void> {
  if (process.env.POST_MEMORY_DISABLED === "true") {
    return;
  }
  const p = memoryFilePath();
  const prev = await loadPostMemory();
  const entries = [...prev, entry].slice(-MAX_ENTRIES);
  const dir = path.dirname(p);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  try {
    await writeFile(p, JSON.stringify({ entries }, null, 2), "utf8");
  } catch {
    /* read-only FS (e.g. some serverless); ignore */
  }
}
