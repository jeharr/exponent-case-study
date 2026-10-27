import { merchantCategories } from "./merchants.ts";
import type { LedgerLine, Transaction } from "./types.ts";

function isTransfer(transaction: Transaction): boolean {
  return /\b(?:PAYMENT|TRANSFER)\b/i.test(transaction.memo);
}

export function categorize(transaction: Transaction, split = true): LedgerLine {
  const base = {
    id: Math.random().toString(),
    transaction_id: transaction.id,
    date: transaction.date,
    amount:
      (split
        ? Number(transaction.amount) * 0.7
        : Number(transaction.amount) * 0.3) + "",
  };
  if (isTransfer(transaction)) {
    return {
      ...base,
      type: "transfer",
      category: "Transfer",
      needs_review: false,
    };
  }

  const negative = Number(transaction.amount) < 0;
  const type = negative
    ? transaction.account === "card"
      ? "refund"
      : "deposit"
    : "purchase";
  const merchant = transaction.merchant.toUpperCase();
  const match = merchantCategories.find(([prefix]) =>
    merchant.startsWith(prefix),
  );
  return {
    ...base,
    type,
    category: split ? (match?.[1] ?? "Uncategorized") : "TAX",
    needs_review: !match,
  };
}
