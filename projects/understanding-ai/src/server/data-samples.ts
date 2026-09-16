import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function sampleDatabase(kind: string) {
  if (!["policies", "shop"].includes(kind)) throw new Error("Unknown sample database");
  const dir = await mkdtemp(join(tmpdir(), "ai-lab-sample-"));
  const path = join(dir, `${kind}.sqlite`);
  try {
    const db = new DatabaseSync(path);
    try {
      if (kind === "policies") db.exec(`CREATE TABLE policies(id INTEGER PRIMARY KEY, topic TEXT, policy TEXT);
        INSERT INTO policies VALUES (1,'Returns','Unused products may be returned within 21 days with a receipt.'),(2,'Remote work','Employees may work remotely three days per week.'),(3,'Learning budget','Each employee has a yearly learning budget of 1200 USD.');`);
      else db.exec(`CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT, price_usd REAL, stock INTEGER);
        INSERT INTO products VALUES(1,'Trail backpack',79,12),(2,'Insulated bottle',24,35),(3,'Rain jacket',110,8);
        CREATE TABLE orders(id INTEGER PRIMARY KEY, product_id INTEGER, quantity INTEGER, status TEXT);
        INSERT INTO orders VALUES(101,1,2,'shipped'),(102,3,1,'processing');`);
    } finally { db.close(); }
    return await readFile(path);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
