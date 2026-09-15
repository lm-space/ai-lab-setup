import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatRecord } from "../shared/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "chats");

async function ensure() {
  await mkdir(ROOT, { recursive: true });
}

export async function listChats(): Promise<ChatRecord[]> {
  await ensure();
  const names = await readdir(ROOT);
  const rows: ChatRecord[] = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    try {
      const rec = JSON.parse(await readFile(join(ROOT, name), "utf8")) as ChatRecord;
      rows.push(rec);
    } catch {
      /* skip bad files */
    }
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows;
}

export async function loadChat(id: string): Promise<ChatRecord | null> {
  await ensure();
  try {
    return JSON.parse(await readFile(join(ROOT, `${id}.json`), "utf8")) as ChatRecord;
  } catch {
    return null;
  }
}

export async function saveChat(rec: ChatRecord): Promise<void> {
  await ensure();
  const slim: ChatRecord = {
    ...rec,
    events: rec.events.map((e) => ({ ...e, flow: e.flow })),
  };
  await writeFile(join(ROOT, `${rec.id}.json`), JSON.stringify(slim, null, 2), "utf8");
}
