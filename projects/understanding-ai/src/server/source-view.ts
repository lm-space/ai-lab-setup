import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { extractText } from "./kb.ts";

export async function previewSource(path: string, name: string) {
  const ext = extname(name).toLowerCase();
  if ([".sqlite", ".sqlite3", ".db"].includes(ext)) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
      const names = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE '%VIRTUAL TABLE%' ORDER BY name").all();
      const tables = names.map(entry => {
        const quoted = `"${String(entry.name).replaceAll('"', '""')}"`;
        const statement = db.prepare(`SELECT * FROM ${quoted}`);
        statement.setReadBigInts(true);
        const records = statement.all();
        const columns = db.prepare(`PRAGMA table_info(${quoted})`).all().map(c => String(c.name));
        return { name: String(entry.name), schema: String(entry.sql), columns, rows: records.map(row => columns.map(key => {
          const value = row[key];
          return value instanceof Uint8Array ? `[BLOB: ${value.length} bytes]` : typeof value === "bigint" ? String(value) : value;
        })) };
      });
      return { mode: "tables", tables, text: "" };
    } finally { db.close(); }
  }
  const bytes = await readFile(path);
  if ([".csv", ".xls", ".xlsx"].includes(ext)) {
    const XLSX = await import("xlsx");
    const book = XLSX.read(bytes, { type: "buffer" });
    return { mode: "tables", text: "", tables: book.SheetNames.map(name => {
      const all = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name], { header: 1, defval: "", raw: false });
      const width = Math.max(0, ...all.map(row => row.length));
      return { name, schema: "First row displayed as headers", columns: Array.from({ length: width }, (_, i) => String(all[0]?.[i] || `Column ${i + 1}`)), rows: all.slice(1) };
    }) };
  }
  const result = await extractText(name, bytes, () => {});
  return { mode: ext === ".md" ? "markdown" : ext === ".pdf" ? "pdf" : "text", text: result.text, tables: [] };
}
