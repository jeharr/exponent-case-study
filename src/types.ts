export interface Transaction {
  id: string;
  sync_batch: number;
  date: string;
  account: "card" | "bank";
  merchant: string;
  memo: string;
  amount: string;
}

export interface LedgerLine {
  transaction_id: string;
  date: string;
  type: "purchase" | "refund" | "deposit" | "transfer";
  category: string;
  amount: string;
  needs_review: boolean;
}

export interface ImportStats {
  inserted: number;
  updated: number;
  unchanged: number;
  stale: number;
}
