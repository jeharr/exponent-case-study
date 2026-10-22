import { merchantCategories } from "./merchants.ts";
import type { LedgerLine, Transaction } from "./types.ts";

function isTransfer(transaction: Transaction): boolean {
  return /\b(?:PAYMENT|TRANSFER)\b/i.test(transaction.memo);
}

export function categorize(transaction: Transaction): LedgerLine {
  const base = {
    transaction_id: transaction.id,
    date: transaction.date,
    amount: transaction.amount,
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
    category: match?.[1] ?? "Uncategorized",
    needs_review: !match,
  };
}
