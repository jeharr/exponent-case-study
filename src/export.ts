import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { serializeLedger } from "./csv.ts";
import { inWriteTransaction, readLedger } from "./store.ts";

export function exportLedger(db: DatabaseSync, output: string): number {
  return inWriteTransaction(db, () => {
    const lines = readLedger(db);
    const temporary = join(
      dirname(output),
      `.${basename(output)}.${randomUUID()}.tmp`,
    );
    try {
      writeFileSync(temporary, serializeLedger(lines), { flag: "wx" });
      renameSync(temporary, output);
    } finally {
      rmSync(temporary, { force: true });
    }
    return lines.length;
  });
}
