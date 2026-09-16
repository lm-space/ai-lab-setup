import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import type { KbDoc } from "../shared/types.ts";
import type { KbChunk } from "./kb.ts";

export class KnowledgeStore {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path, { allowExtension: true });
    sqliteVec.load(this.db);
    this.db.enableLoadExtension(false);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, metadata TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS vectors USING vec0(id TEXT PRIMARY KEY, embedding float[384] distance_metric=cosine);
      CREATE VIRTUAL TABLE IF NOT EXISTS keywords USING fts5(id UNINDEXED, text);
      CREATE TABLE IF NOT EXISTS migrations(name TEXT PRIMARY KEY);`);
  }
  read() {
    return {
      docs: this.db.prepare("SELECT metadata FROM documents").all().map(r => JSON.parse(String(r.metadata)) as KbDoc),
      chunks: this.db.prepare("SELECT metadata FROM chunks").all().map(r => JSON.parse(String(r.metadata)) as KbChunk),
    };
  }
  write(docs: KbDoc[], chunks: KbChunk[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM documents; DELETE FROM chunks; DELETE FROM vectors; DELETE FROM keywords;");
      const doc = this.db.prepare("INSERT INTO documents VALUES (?, ?)");
      const chunk = this.db.prepare("INSERT INTO chunks VALUES (?, ?, ?)");
      const vector = this.db.prepare("INSERT INTO vectors VALUES (?, ?)");
      const keyword = this.db.prepare("INSERT INTO keywords VALUES (?, ?)");
      for (const d of docs) doc.run(d.id, JSON.stringify(d));
      for (const c of chunks) {
        chunk.run(c.id, c.docId, JSON.stringify(c));
        vector.run(c.id, new Uint8Array(new Float32Array(c.vector).buffer));
        keyword.run(c.id, c.text);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  retrieve(query: string, vector: number[], k: number) {
    const limit = Math.max(1, Math.min(k, 12));
    const semantic = this.db.prepare("SELECT id, distance FROM vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance").all(new Uint8Array(new Float32Array(vector).buffer), Math.max(limit * 3, 20));
    const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 24).map(t => `"${t}"`).join(" OR ");
    const lexical = terms ? this.db.prepare("SELECT id FROM keywords WHERE keywords MATCH ? ORDER BY bm25(keywords) LIMIT 36").all(terms) : [];
    const ranks = new Map<string, { score: number; similarity?: number; vectorRank?: number; keywordRank?: number }>();
    semantic.forEach((r, i) => ranks.set(String(r.id), { score: 1 / (60 + i + 1), similarity: 1 - Number(r.distance), vectorRank: i + 1 }));
    lexical.forEach((r, i) => { const id = String(r.id), entry = ranks.get(id) || { score: 0 }; entry.score += 1 / (60 + i + 1); entry.keywordRank = i + 1; ranks.set(id, entry); });
    return [...ranks].sort((a, b) => b[1].score - a[1].score).slice(0, limit).map(([id, rank]) => {
      const c = JSON.parse(String(this.db.prepare("SELECT metadata FROM chunks WHERE id = ?").get(id)!.metadata)) as KbChunk;
      return { id, docId: c.docId, name: c.name, i: c.i, text: c.text, ...rank };
    });
  }
  close() { this.db.close(); }
}
