import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { parse } from "csv-parse/sync";
import { parseFeed, serializeLedger } from "../src/csv.ts";
import { importTransactions, openStore, readLedger } from "../src/store.ts";
import { temporaryDirectory, transaction } from "./helpers.ts";

function memoryStore(t: TestContext): DatabaseSync {
  const db = openStore(":memory:");
  t.after(() => db.close());
  return db;
}

function snapshot(db: DatabaseSync) {
  return {
    sources: db.prepare("SELECT * FROM transactions ORDER BY position").all(),
    ledger: db.prepare("SELECT * FROM ledger_lines ORDER BY transaction_id").all()
  };
}

test("database constraints enforce unique source IDs, unique ledger IDs, and a source for every line", (t) => {
  const db = memoryStore(t);
  importTransactions(db, [transaction()]);
  assert.throws(() => db.exec(`
    INSERT INTO transactions (id, sync_batch, date, account, merchant, memo, amount)
    SELECT id, sync_batch, date, account, merchant, memo, amount FROM transactions
  `), /UNIQUE constraint failed: transactions.id/);
  assert.throws(() => db.exec("INSERT INTO ledger_lines SELECT * FROM ledger_lines"), /UNIQUE constraint/);
  assert.throws(() => db.exec("INSERT INTO ledger_lines VALUES ('missing', 'purchase', 'Uncategorized', 1)"), /FOREIGN KEY constraint/);
});

test("replay after closing and reopening the database makes zero row changes", (t) => {
  const path = join(temporaryDirectory(t), "ledger.sqlite");
  const first = openStore(path);
  importTransactions(first, [transaction(), transaction({ id: "txn_2" })]);
  const before = snapshot(first);
  first.close();

  const retry = openStore(path);
  t.after(() => retry.close());
  const changesBefore = retry.prepare("SELECT total_changes() AS count").get()?.count;
  assert.deepEqual(importTransactions(retry, [transaction(), transaction({ id: "txn_2" })]), {
    inserted: 0, updated: 0, unchanged: 2, stale: 0
  });
  assert.deepEqual(snapshot(retry), before);
  assert.equal(retry.prepare("SELECT total_changes() AS count").get()?.count, changesBefore);
});

test("a newer batch updates all source fields and classification in place without changing order", (t) => {
  const db = memoryStore(t);
  importTransactions(db, [transaction(), transaction({ id: "txn_2" })]);
  const revised = transaction({
    sync_batch: 10, date: "2026-08-04", account: "bank", merchant: "TOAST PAYOUT",
    memo: "Posted payout", amount: "-62.40"
  });
  assert.deepEqual(importTransactions(db, [revised]), { inserted: 0, updated: 1, unchanged: 0, stale: 0 });
  const lines = readLedger(db);
  assert.deepEqual(lines.map((line) => line.transaction_id), ["txn_1", "txn_2"]);
  assert.deepEqual(lines[0], {
    transaction_id: "txn_1", date: "2026-08-04", type: "deposit",
    category: "Card sales", amount: "-62.40", needs_review: false
  });
  const saved = db.prepare("SELECT * FROM transactions WHERE id = 'txn_1'").get();
  assert.equal(saved?.sync_batch, 10);
  assert.equal(saved?.memo, "Posted payout");
  assert.equal(saved?.account, "bank");
});

test("older batches and conflicting obsolete versions cannot overwrite a newer stored version", (t) => {
  const db = memoryStore(t);
  importTransactions(db, [transaction({ sync_batch: 10, amount: "62.40" })]);
  const before = snapshot(db);
  const changesBefore = db.prepare("SELECT total_changes() AS count").get()?.count;
  assert.deepEqual(importTransactions(db, [
    transaction({ sync_batch: 2 }), transaction({ sync_batch: 2, amount: "999.00" })
  ]), { inserted: 0, updated: 0, unchanged: 0, stale: 2 });
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare("SELECT total_changes() AS count").get()?.count, changesBefore);
});

test("the highest batch in a feed wins regardless of input order; duplicates cause no extra writes", (t) => {
  const db = memoryStore(t);
  const old = transaction({ sync_batch: 2, amount: "1.00" });
  const latest = transaction({ sync_batch: 10, amount: "62.40" });
  assert.deepEqual(importTransactions(db, [old, latest, latest]), {
    inserted: 1, updated: 0, unchanged: 1, stale: 1
  });
  assert.equal(readLedger(db)[0]?.amount, "62.40");
  assert.deepEqual(importTransactions(db, [latest, old]), {
    inserted: 0, updated: 0, unchanged: 1, stale: 1
  });
});

test("conflicts among superseded versions within one feed are ignored", (t) => {
  const db = memoryStore(t);
  importTransactions(db, [transaction(), transaction({ amount: "999.00" }), transaction({ sync_batch: 2 })]);
  assert.equal(readLedger(db).length, 1);
  assert.equal(readLedger(db)[0]?.amount, "100.00");
});

test("same-batch conflicts roll back preceding inserts and preserve the committed ledger", (t) => {
  const db = memoryStore(t);
  importTransactions(db, [transaction()]);
  const before = snapshot(db);
  assert.throws(() => importTransactions(db, [
    transaction({ id: "txn_new" }), transaction({ amount: "200.00" })
  ]), /Conflicting payload for txn_1 at sync_batch 1/);
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(importTransactions(db, [transaction({ id: "txn_new" }), transaction()]), {
    inserted: 1, updated: 0, unchanged: 1, stale: 0
  });
});

test("a conflicting new ID at the highest batch also rejects the whole import", (t) => {
  const db = memoryStore(t);
  assert.throws(() => importTransactions(db, [transaction(), transaction({ memo: "Different" })]), /Conflicting payload/);
  assert.deepEqual(readLedger(db), []);
  assert.deepEqual(db.prepare("SELECT * FROM transactions").all(), []);
});

test("same-version equality is exact, including amount formatting and source-only fields", (t) => {
  const db = memoryStore(t);
  importTransactions(db, [transaction()]);
  for (const change of [
    { amount: "100.0" }, { memo: "Another memo" }, { merchant: "sysco" },
    { account: "bank" as const }, { date: "2026-08-04" }
  ]) {
    assert.throws(() => importTransactions(db, [transaction(change)]), /Conflicting payload/);
  }
});

test("a real failure between source and ledger updates rolls back ALL writes and allows retry", (t) => {
  const db = memoryStore(t);
  importTransactions(db, [transaction()]);
  const before = snapshot(db);
  db.exec(`CREATE TRIGGER fail_ledger_write BEFORE UPDATE ON ledger_lines
    WHEN NEW.transaction_id = 'txn_1'
    BEGIN SELECT RAISE(ABORT, 'simulated ledger write failure'); END;`);
  const feed = [transaction({ id: "txn_new" }), transaction({ sync_batch: 2, merchant: "HOME DEPOT", amount: "222.00" })];
  assert.throws(() => importTransactions(db, feed), /simulated ledger write failure/);
  assert.deepEqual(snapshot(db), before);
  db.exec("DROP TRIGGER fail_ledger_write");
  assert.deepEqual(importTransactions(db, feed), { inserted: 1, updated: 1, unchanged: 0, stale: 0 });
  assert.equal(readLedger(db)[0]?.category, "Repairs & maintenance");
  assert.equal(readLedger(db).length, 2);
});

test("cumulative exports retain prior IDs and their first-import order across updates", (t) => {
  const db = memoryStore(t);
  importTransactions(db, [transaction({ id: "z", date: "2026-08-10" })]);
  importTransactions(db, [transaction({ id: "a", date: "2026-08-01" })]);
  importTransactions(db, [transaction({ id: "z", sync_batch: 2, amount: "20.00" })]);
  assert.deepEqual(readLedger(db).map((line) => line.transaction_id), ["z", "a"]);
  assert.deepEqual(importTransactions(db, []), { inserted: 0, updated: 0, unchanged: 0, stale: 0 });
  assert.equal(readLedger(db).length, 2);
});

test("automatic SQLite rollback preserves the original error and permits a clean retry", (t) => {
  const db = memoryStore(t);
  importTransactions(db, [transaction()]);
  const before = snapshot(db);
  db.exec(`CREATE TRIGGER abort_transaction BEFORE UPDATE ON ledger_lines
    BEGIN SELECT RAISE(ROLLBACK, 'SQLite rolled back the transaction'); END;`);
  const feed = [transaction({ id: "txn_new" }), transaction({ sync_batch: 2, amount: "200.00" })];
  assert.throws(() => importTransactions(db, feed), /SQLite rolled back the transaction/);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(snapshot(db), before);
  db.exec("DROP TRIGGER abort_transaction");
  assert.deepEqual(importTransactions(db, feed), { inserted: 1, updated: 1, unchanged: 0, stale: 0 });
});

test("the full fixture produces 56 lines, matches the first 15, and replays without writes", (t) => {
  const db = memoryStore(t);
  const fixture = (file: string) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
  const feed = parseFeed(fixture("transactions.csv"));
  assert.equal(feed.length, 60);
  assert.deepEqual(importTransactions(db, feed), { inserted: 56, updated: 0, unchanged: 0, stale: 4 });
  const lines = readLedger(db);
  assert.equal(lines.length, 56);
  assert.deepEqual(parse(serializeLedger(lines.slice(0, 15)), { columns: true }),
    parse(fixture("expected_first_15.csv"), { columns: true }));
  const byId = new Map(lines.map((line) => [line.transaction_id, line]));
  assert.equal(byId.get("txn_1020")?.amount, "62.40");
  assert.equal(byId.get("txn_1046")?.amount, "518.35");
  assert.equal(byId.get("txn_1022")?.category, "Transfer");
  for (const id of ["txn_1016", "txn_1017", "txn_1022", "txn_1027", "txn_1040", "txn_1051", "txn_1052"]) {
    assert.equal(byId.get(id)?.type, "transfer", id);
  }
  const before = snapshot(db);
  const changesBefore = db.prepare("SELECT total_changes() AS count").get()?.count;
  assert.deepEqual(importTransactions(db, feed), { inserted: 0, updated: 0, unchanged: 56, stale: 4 });
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare("SELECT total_changes() AS count").get()?.count, changesBefore);
});
