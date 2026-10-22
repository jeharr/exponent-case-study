import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseFeed } from "./csv.ts";
import { exportLedger } from "./export.ts";
import { importTransactions, openStore } from "./store.ts";

const usage = "Usage: npm start -- [transactions.csv] [--db ledger.sqlite] [--out ledger_lines.csv]";
const defaultInput = fileURLToPath(new URL("../tests/fixtures/transactions.csv", import.meta.url));

function printCsv(path: string, contents: string): void {
  console.log(`\n--- ${basename(path)} ---`);
  process.stdout.write(contents);
  if (!contents.endsWith("\n")) process.stdout.write("\n");
}

function pathIdentity(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return existsSync(parent) ? join(realpathSync(parent), basename(absolute)) : absolute;
}

function run(): void {
  const { values, positionals } = parseArgs({
    options: {
      db: { type: "string", default: "ledger.sqlite" },
      out: { type: "string", default: "ledger_lines.csv" },
      help: { type: "boolean", short: "h" }
    },
    allowPositionals: true
  });
  if (values.help) { console.log(usage); return; }
  if (positionals.length > 1) throw new Error(usage);
  const input = positionals[0] ?? defaultInput;
  const dbPath = values.db!;
  const output = values.out!;
  const identities = [input, dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`, output].map(pathIdentity);
  if (new Set(identities).size !== identities.length) {
    throw new Error("Input, output, database, and SQLite sidecar paths must differ");
  }

  // Reject invalid CSV before opening the database or beginning an import.
  const inputCsv = readFileSync(input, "utf8");
  const feed = parseFeed(inputCsv);
  const db = openStore(dbPath);
  try {
    const stats = importTransactions(db, feed);
    console.log(`Import committed: ${stats.inserted} inserted, ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.stale} stale`);
    try {
      const count = exportLedger(db, output);
      console.log(`Exported ${count} ledger lines to ${output}`);
      printCsv(output, readFileSync(output, "utf8"));
    } catch (error) {
      throw new Error(`Import committed, but CSV export failed. Fix the output path and rerun the same command safely. ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    db.close();
  }
}

try { run(); }
catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
