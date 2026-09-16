import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "../src/server/knowledge-store.ts";
import { inspectSqlite } from "../src/server/kb.ts";
import { sampleDatabase } from "../src/server/data-samples.ts";
import { DatabaseSync } from "node:sqlite";

test("SQLite persists vectors, fuses keyword ranks and removes all indexes atomically", () => {
  const db = new KnowledgeStore(":memory:");
  const vector = Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0);
  const chunks = ["Returns allowed for 21 days", "Learning budget is 1200 dollars"].map((text, i) => ({ id: `c${i}`, docId: "d", name: "policies", i, text, vector }));
  try {
    db.write([], chunks);
    assert.equal(db.read().chunks.length, 2);
    const hits = db.retrieve("learning budget", vector, 2);
    assert.equal(hits[0].id, "c1"); assert.equal(hits[0].keywordRank, 1);
    assert.ok(hits[0].similarity! > .99);
    assert.throws(() => db.write([], [{ ...chunks[0], vector: [1, 2] }]));
    assert.equal(db.read().chunks.length, 2, "failed write rolls back all indexes");
    db.write([], []);
    assert.deepEqual(db.retrieve("budget", vector, 2), []);
  } finally { db.close(); }
});

test("sample SQLite sources import real tables and reject oversized sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lab-test-"));
  try {
    for (const kind of ["policies", "shop"]) {
      const path = join(dir, `${kind}.sqlite`);
      await writeFile(path, await sampleDatabase(kind));
      const before = inspectSqlite(path);
      assert.ok(before.tables.length >= 3);
      assert.match(before.text, /SQLite tables:/);
      assert.deepEqual(inspectSqlite(path), before);
    }
    const path = join(dir, "large.sqlite");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE rows(value TEXT); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<501) INSERT INTO rows SELECT x FROM n;");
    db.close();
    assert.throws(() => inspectSqlite(path), /exceeds 500/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("CSV and Excel preserve quoted cells and worksheet contents", async () => {
  const { extractText } = await import("../src/server/kb.ts");
  const XLSX = await import("xlsx");
  const csv = await extractText("quoted.csv", Buffer.from('name,note\n"Fox, Pixel","line one\nline two"\n'), () => {});
  assert.deepEqual(csv.cols, ["name", "note"]);
  assert.match(csv.tables![0], /Fox, Pixel/);
  assert.match(csv.tables![0], /line one\\nline two/);
  for (const ext of ["xls", "xlsx"] as const) {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["item", "price"], ["Trail backpack", 79]]), "Products");
    const result = await extractText(`shop.${ext}`, XLSX.write(workbook, { type: "buffer", bookType: ext }), () => {});
    assert.match(result.tables![0], /Trail backpack/);
    assert.deepEqual(result.cols, ["item", "price"]);
  }
});

test("source viewers expose SQLite tables, spreadsheet cells and full Markdown", async () => {
  const { previewSource } = await import("../src/server/source-view.ts");
  const dir = await mkdtemp(join(tmpdir(), "lab-view-"));
  try {
    const dbPath = join(dir, "shop.sqlite");
    await writeFile(dbPath, await sampleDatabase("shop"));
    const db = await previewSource(dbPath, "shop.sqlite");
    assert.equal(db.mode, "tables");
    assert.deepEqual(db.tables.map(t => t.name), ["orders", "products"]);
    assert.equal(db.tables[1].rows.length, 3);
    assert.ok(db.tables[1].rows.some(r => r.includes("Trail backpack")));
    const csvPath = join(dir, "cells.csv");
    await writeFile(csvPath, 'name,note\n"Fox, Pixel","two\nlines"\n');
    const csv = await previewSource(csvPath, "cells.csv");
    assert.deepEqual(csv.tables[0].rows[0], ["Fox, Pixel", "two\nlines"]);
    const mdPath = join(dir, "readme.md");
    await writeFile(mdPath, "# Full content\n\nA paragraph beyond the card preview.");
    const md = await previewSource(mdPath, "readme.md");
    assert.equal(md.mode, "markdown"); assert.match(md.text, /beyond the card preview/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
