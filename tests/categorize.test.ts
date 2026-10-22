import assert from "node:assert/strict";
import { test } from "node:test";
import { categorize } from "../src/categorize.ts";
import { merchantCategories } from "../src/merchants.ts";
import type { Transaction } from "../src/types.ts";
import { transaction } from "./helpers.ts";

test("merchant names match case-insensitive prefixes with trailing store information", () => {
  for (const [merchant, category] of merchantCategories) {
    const line = categorize(
      transaction({ merchant: `${merchant.toLowerCase()} #123` }),
    );
    assert.equal(line.category, category, merchant);
    assert.equal(line.needs_review, false);
  }
  const unknown = categorize(
    transaction({ merchant: "NOT SYSCO", memo: "SYSCO" }),
  );
  assert.equal(unknown.category, "Uncategorized");
  assert.equal(unknown.needs_review, true);
});

test("card payments and both directions of savings transfers take precedence", () => {
  const examples: Partial<Transaction>[] = [
    { account: "bank", memo: "ONLINE PAYMENT TO CARD 4421", amount: "4850.00" },
    { account: "card", memo: "online payment - thank you", amount: "-4850.00" },
    { account: "card", memo: "PAYMENT RECEIVED", amount: "-10.00" },
    { account: "bank", memo: "CARD PAYMENT 4421", amount: "10.00" },
    {
      account: "bank",
      memo: "ONLINE TRANSFER TO SAVINGS 8810",
      amount: "10000.00",
    },
    {
      account: "bank",
      memo: "ONLINE TRANSFER FROM SAVINGS 8810",
      amount: "-5000.00",
    },
  ];
  for (const example of examples) {
    const line = categorize(transaction({ merchant: "Unknown", ...example }));
    assert.equal(line.type, "transfer", example.memo);
    assert.equal(line.category, "Transfer");
    assert.equal(line.needs_review, false);
    assert.equal(line.amount, example.amount);
  }
});

test("PAYMENT and TRANSFER in the memo identify transfers regardless of account or sign", () => {
  for (const account of ["bank", "card"] as const) {
    for (const amount of ["10.00", "-10.00"]) {
      for (const memo of [
        "payment",
        "Transfer",
        "ACH PAYMENT MAINLINE PROPERTIES",
        "ACCOUNT TRANSFER POSTED",
      ]) {
        const line = categorize(
          transaction({
            account,
            amount,
            memo,
            merchant: "MAINLINE PROPERTIES LLC",
          }),
        );
        assert.equal(line.type, "transfer", memo);
        assert.equal(line.category, "Transfer");
        assert.equal(line.needs_review, false);
        assert.equal(line.amount, amount);
      }
    }
  }
});

test("unknown merchants require review for purchases, refunds, and deposits", () => {
  for (const example of [
    { account: "card", amount: "84.12", type: "purchase" },
    { account: "card", amount: "-41.99", type: "refund" },
    { account: "bank", amount: "-10.00", type: "deposit" },
  ] as const) {
    const line = categorize(transaction({ ...example, merchant: "UNKNOWN" }));
    assert.equal(line.type, example.type);
    assert.equal(line.category, "Uncategorized");
    assert.equal(line.needs_review, true);
  }
});
