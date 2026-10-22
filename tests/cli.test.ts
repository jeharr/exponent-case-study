import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { serializeLedger } from "../src/csv.ts";
import { importTransactions, openStore, readLedger } from "../src/store.ts";
import type { Transaction } from "../src/types.ts";
import { temporaryDirectory, transaction } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/transactions.csv", import.meta.url));
const columns = ["id", "sync_batch", "date", "account", "merchant", "memo", "amount"];

function writeFeed(path: string, rows: Transaction[]): void {
  writeFileSync(path, stringify(rows, { header: true, columns }));
}

function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", timeout: 10000 });
}

function runAsync(args: string[], cwd: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, timeout: 10000, killSignal: "SIGKILL" });
    let stderr = "";
    child.stdout.resume();
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("CLI creates the default database and output and safely replays the supplied feed", (t) => {
  const directory = temporaryDirectory(t);
  const first = run([], directory);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /56 inserted/);
  assert.ok(existsSync(join(directory, "ledger.sqlite")));
  const output = join(directory, "ledger_lines.csv");
  const contents = readFileSync(output, "utf8");
  assert.equal(parse(contents, { columns: true }).length, 56);
  assert.doesNotMatch(first.stdout, /--- transactions.csv ---/);
  assert.ok(!first.stdout.includes(readFileSync(fixture, "utf8")));
  assert.match(first.stdout, /--- ledger_lines.csv ---/);
  assert.ok(first.stdout.includes(contents));
  const retry = run([fixture], directory);
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /0 inserted, 0 updated, 56 unchanged, 4 stale/);
  assert.equal(readFileSync(output, "utf8"), contents);
});

test("export failure leaves a committed import that can be safely replayed", (t) => {
  const directory = temporaryDirectory(t);
  const input = join(directory, "feed.csv");
  writeFeed(input, [transaction()]);
  const failed = run([input, "--out", join(directory, "missing", "output.csv")], directory);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Import committed, but CSV export failed/);
  const db = openStore(join(directory, "ledger.sqlite"));
  assert.equal(readLedger(db).length, 1);
  db.close();
  const retry = run([input, "--out", "recovered.csv"], directory);
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /0 inserted, 0 updated, 1 unchanged, 0 stale/);
  assert.doesNotMatch(retry.stdout, /--- feed.csv ---/);
  assert.ok(!retry.stdout.includes(readFileSync(input, "utf8")));
  assert.match(retry.stdout, /--- recovered.csv ---/);
  assert.ok(retry.stdout.includes(readFileSync(join(directory, "recovered.csv"), "utf8")));
  assert.equal(parse(readFileSync(join(directory, "recovered.csv"), "utf8"), { columns: true }).length, 1);
});

test("invalid feeds and conflicting imports preserve the existing database and CSV", (t) => {
  const directory = temporaryDirectory(t);
  const input = join(directory, "feed.csv");
  writeFeed(input, [transaction()]);
  assert.equal(run([input], directory).status, 0);
  const before = readFileSync(join(directory, "ledger_lines.csv"), "utf8");
  writeFeed(input, [transaction({ id: "txn_new" }), transaction({ amount: "200.00" })]);
  const conflict = run([input], directory);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /Conflicting payload/);
  assert.equal(readFileSync(join(directory, "ledger_lines.csv"), "utf8"), before);
  writeFileSync(input, "bad header\n");
  assert.equal(run([input], directory).status, 1);
  const db = openStore(join(directory, "ledger.sqlite"));
  t.after(() => db.close());
  assert.equal(readLedger(db).length, 1);
  assert.equal(readFileSync(join(directory, "ledger_lines.csv"), "utf8"), before);
});

test("input, output, and database paths cannot overwrite each other", (t) => {
  const directory = temporaryDirectory(t);
  const input = join(directory, "feed.csv");
  writeFeed(input, [transaction()]);
  const before = readFileSync(input, "utf8");
  for (const args of [
    [input, "--out", input], [input, "--db", input],
    [input, "--db", "same.sqlite", "--out", "same.sqlite"],
    [input, "--db", "same.sqlite", "--out", "same.sqlite-wal"]
  ]) {
    const result = run(args, directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /paths must differ/);
  }
  assert.equal(readFileSync(input, "utf8"), before);
});

test("CLI offers help, rejects bad arguments, and reports missing input", (t) => {
  const directory = temporaryDirectory(t);
  assert.equal(run(["--help"], directory).status, 0);
  assert.match(run([fixture, fixture], directory).stderr, /Usage:/);
  assert.equal(run(["--unknown"], directory).status, 1);
  assert.equal(run(["missing.csv"], directory).status, 1);
  assert.equal(existsSync(join(directory, "ledger.sqlite")), false);
});

test("concurrent processes on a fresh database keep the newest batch and final export", { timeout: 15000 }, async (t) => {
  const directory = temporaryDirectory(t);
  const paths = ["older.csv", "newer.csv", "replay.csv"].map((name) => join(directory, name));
  writeFeed(paths[0]!, [transaction({ sync_batch: 2, amount: "2.00" }), transaction({ id: "older_only" })]);
  writeFeed(paths[1]!, [transaction({ sync_batch: 10, amount: "10.00" }), transaction({ id: "newer_only" })]);
  writeFeed(paths[2]!, [transaction({ sync_batch: 10, amount: "10.00" })]);
  const results = await Promise.all(paths.map((path) => runAsync([path], directory)));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const db = openStore(join(directory, "ledger.sqlite"));
  t.after(() => db.close());
  const ledger = readLedger(db);
  assert.equal(ledger.length, 3);
  assert.equal(ledger.find((line) => line.transaction_id === "txn_1")?.amount, "10.00");
  assert.equal(readFileSync(join(directory, "ledger_lines.csv"), "utf8"), serializeLedger(ledger));
});

test("SQLite recovers an uncommitted source update after the writer process is killed", { timeout: 10000 }, async (t) => {
  const directory = temporaryDirectory(t);
  const dbPath = join(directory, "ledger.sqlite");
  const seed = openStore(dbPath);
  importTransactions(seed, [transaction()]);
  const before = readLedger(seed);
  seed.close();
  const storeUrl = new URL("../src/store.ts", import.meta.url).href;
  const code = `
    import { openStore } from ${JSON.stringify(storeUrl)};
    const db = openStore(process.argv[1]);
    db.exec("BEGIN IMMEDIATE");
    db.exec("UPDATE transactions SET sync_batch = 2, amount = '999.00' WHERE id = 'txn_1'");
    console.log('source written, ledger not written, transaction not committed');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, dbPath]);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const closed = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("close", () => reject(new Error(`Writer exited before checkpoint: ${stderr}`)));
  });
  child.kill("SIGKILL");
  await closed;
  const recovered = openStore(dbPath);
  t.after(() => recovered.close());
  assert.deepEqual(readLedger(recovered), before);
  assert.equal(recovered.prepare("SELECT sync_batch FROM transactions").get()?.sync_batch, 1);
  assert.deepEqual(importTransactions(recovered, [transaction({ sync_batch: 2, amount: "200.00" })]), {
    inserted: 0, updated: 1, unchanged: 0, stale: 0
  });
});
