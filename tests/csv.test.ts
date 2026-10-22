import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFeed, serializeLedger } from "../src/csv.ts";

const header = "id,sync_batch,date,account,merchant,memo,amount\n";

test("reads quoted fields, a BOM, blank lines, and preserves decimal precision", () => {
  const [row] = parseFeed('\uFEFF' + header + '\n1,2,2026-08-03,card,"SYSCO, INC","A ""quoted"" memo",100.00\n');
  assert.deepEqual(row, {
    id: "1", sync_batch: 2, date: "2026-08-03", account: "card",
    merchant: "SYSCO, INC", memo: 'A "quoted" memo', amount: "100.00"
  });
});

test("identifies columns by name rather than their order", () => {
  const rows = parseFeed("amount,memo,merchant,account,date,sync_batch,id\n-10.00,Return,SYSCO,card,2026-08-03,1,txn_1\n");
  assert.equal(rows[0]?.id, "txn_1");
  assert.equal(rows[0]?.amount, "-10.00");
});

test("requires exactly the declared columns without duplicates", () => {
  assert.throws(() => parseFeed(""), /Empty input/);
  assert.throws(() => parseFeed("wrong,header\n"), /Expected CSV columns/);
  assert.throws(() => parseFeed("id,id,date,account,merchant,memo,amount\n"), /Expected CSV columns/);
  assert.throws(() => parseFeed(header + "1,2,2026-08-03\n"));
});

test("validates every record before returning a feed", () => {
  const valid = ["1", "1", "2026-08-03", "card", "SYSCO", "Delivery", "12.00"];
  for (const [index, value] of [
    [0, ""], [0, " "], [1, "bad"], [1, "9007199254740992"], [1, "1.5"],
    [1, "-1"], [2, "2026-02-30"], [3, "savings"], [6, "NaN"], [6, "12.345"]
  ] as const) {
    const row = [...valid];
    row[index] = value;
    assert.throws(() => parseFeed(header + valid.join(",") + "\n" + row.join(",") + "\n"),
      /Record 2:/);
  }
});

test("header-only feeds are valid and empty ledgers retain the output header", () => {
  assert.deepEqual(parseFeed(header), []);
  assert.equal(serializeLedger([]), "transaction_id,date,type,category,amount,needs_review\n");
});

test("serializes boolean flags as true/false and amounts without coercion", () => {
  assert.equal(serializeLedger([{
    transaction_id: "txn_1", date: "2026-08-03", type: "refund",
    category: "Uncategorized", amount: "-41.90", needs_review: true
  }]), "transaction_id,date,type,category,amount,needs_review\ntxn_1,2026-08-03,refund,Uncategorized,-41.90,true\n");
});
