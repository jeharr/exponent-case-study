import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Transaction } from "../src/types.ts";

export function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "txn_1", sync_batch: 1, date: "2026-08-03", account: "card",
    merchant: "SYSCO", memo: "Delivery", amount: "100.00", ...overrides
  };
}

export function temporaryDirectory(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "categorizer-db-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
