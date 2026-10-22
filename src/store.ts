import { DatabaseSync } from "node:sqlite";
import { categorize } from "./categorize.ts";
import type { ImportStats, LedgerLine, Transaction } from "./types.ts";

export function inWriteTransaction<T>(db: DatabaseSync, operation: () => T): T {
  // Acquire the writer lock BEFORE reading versions, including across processes.
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function openStore(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    inWriteTransaction(db, () =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        position INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        sync_batch INTEGER NOT NULL CHECK (sync_batch >= 0),
        date TEXT NOT NULL,
        account TEXT NOT NULL CHECK (account IN ('bank', 'card')),
        merchant TEXT NOT NULL,
        memo TEXT NOT NULL,
        amount TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ledger_lines (
        transaction_id TEXT NOT NULL PRIMARY KEY REFERENCES transactions(id),
        type TEXT NOT NULL CHECK (type IN ('purchase', 'refund', 'deposit', 'transfer')),
        category TEXT NOT NULL,
        needs_review INTEGER NOT NULL CHECK (needs_review IN (0, 1))
      ) STRICT;
    `),
    );
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const payloadFields = [
  "date",
  "account",
  "merchant",
  "memo",
  "amount",
] as const;

export function importTransactions(
  db: DatabaseSync,
  feed: readonly Transaction[],
): ImportStats {
  const groups = new Map<string, Transaction[]>();
  for (const row of feed) {
    const group = groups.get(row.id);
    if (group) group.push(row);
    else groups.set(row.id, [row]);
  }

  return inWriteTransaction(db, () => {
    const stats: ImportStats = {
      inserted: 0,
      updated: 0,
      unchanged: 0,
      stale: 0,
    };
    const find = db.prepare("SELECT * FROM transactions WHERE id = ?");
    const saveSource = db.prepare(`
      INSERT INTO transactions (id, sync_batch, date, account, merchant, memo, amount)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        sync_batch = excluded.sync_batch, date = excluded.date, account = excluded.account,
        merchant = excluded.merchant, memo = excluded.memo, amount = excluded.amount
      WHERE excluded.sync_batch > transactions.sync_batch
    `);
    const saveLedger = db.prepare(`
      INSERT INTO ledger_lines (transaction_id, type, category, needs_review)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(transaction_id) DO UPDATE SET
        type = excluded.type, category = excluded.category, needs_review = excluded.needs_review
    `);

    // Map iteration preserves each ID's first appearance, even if its winner is later.
    for (const [id, group] of groups) {
      const winner = group.reduce((latest, row) =>
        row.sync_batch > latest.sync_batch ? row : latest,
      );
      const stored = find.get(id);
      if (stored && Number(stored.sync_batch) > winner.sync_batch) {
        stats.stale += group.length;
        continue;
      }

      const newest = group.filter(
        (row) => row.sync_batch === winner.sync_batch,
      );
      const conflict =
        newest.some((row) =>
          payloadFields.some((field) => row[field] !== winner[field]),
        ) ||
        (stored?.sync_batch === winner.sync_batch &&
          payloadFields.some((field) => stored[field] !== winner[field]));
      if (conflict)
        throw new Error(
          `Conflicting payload for ${id} at sync_batch ${winner.sync_batch}`,
        );

      stats.stale += group.length - newest.length;
      if (stored?.sync_batch === winner.sync_batch) {
        stats.unchanged += newest.length;
        continue;
      }

      const line = categorize(winner);
      saveSource.run(
        id,
        winner.sync_batch,
        winner.date,
        winner.account,
        winner.merchant,
        winner.memo,
        winner.amount,
      );
      saveLedger.run(id, line.type, line.category, Number(line.needs_review));
      if (stored) stats.updated++;
      else stats.inserted++;
      stats.unchanged += newest.length - 1;
    }
    return stats;
  });
}

export function readLedger(db: DatabaseSync): LedgerLine[] {
  const rows = db
    .prepare(
      `
    SELECT t.id AS transaction_id, t.date, l.type, l.category, t.amount, l.needs_review
    FROM transactions t JOIN ledger_lines l ON l.transaction_id = t.id
    ORDER BY t.position
  `,
    )
    .all();
  return rows.map((row) => {
    const type = row.type;
    if (
      type !== "purchase" &&
      type !== "refund" &&
      type !== "deposit" &&
      type !== "transfer"
    ) {
      throw new Error("Invalid ledger type in database");
    }
    return {
      transaction_id: String(row.transaction_id),
      date: String(row.date),
      type,
      category: String(row.category),
      amount: String(row.amount),
      needs_review: row.needs_review === 1,
    };
  });
}
