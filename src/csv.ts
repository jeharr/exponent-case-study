import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import type { LedgerLine, Transaction } from "./types.ts";

const inputColumns = ["id", "sync_batch", "date", "account", "merchant", "memo", "amount"];
const outputColumns = ["transaction_id", "date", "type", "category", "amount", "needs_review"];

export function parseFeed(contents: string): Transaction[] {
  let foundHeader = false;
  const records = parse<Record<string, string>>(contents, {
    bom: true,
    skip_empty_lines: true,
    columns(header: string[]) {
      foundHeader = true;
      if (header.length !== inputColumns.length || new Set(header).size !== header.length ||
          inputColumns.some((column) => !header.includes(column))) {
        throw new Error(`Expected CSV columns: ${inputColumns.join(",")}`);
      }
      return header;
    }
  });
  if (!foundHeader) throw new Error("Empty input: expected a CSV header");

  return records.map((record, index) => {
    const { id, sync_batch, date, account, merchant, memo, amount } = record;
    const invalid = (reason: string): never => { throw new Error(`Record ${index + 1}: ${reason}`); };
    if (!id || !id.trim()) return invalid("id is required");
    if (!sync_batch || !/^\d+$/.test(sync_batch) || !Number.isSafeInteger(Number(sync_batch))) {
      return invalid("sync_batch must be a nonnegative safe integer");
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
      return invalid("date must be a valid YYYY-MM-DD date");
    }
    if (account !== "bank" && account !== "card") return invalid("account must be bank or card");
    if (merchant === undefined || memo === undefined) return invalid("missing merchant or memo");
    if (!amount || !/^[+-]?\d+(?:\.\d{1,2})?$/.test(amount)) {
      return invalid("amount must be a signed decimal with at most two fractional digits");
    }
    return { id, sync_batch: Number(sync_batch), date, account, merchant, memo, amount };
  });
}

export function serializeLedger(lines: readonly LedgerLine[]): string {
  return stringify([...lines], {
    header: true,
    columns: outputColumns,
    cast: { boolean: (value: boolean) => String(value) }
  });
}
