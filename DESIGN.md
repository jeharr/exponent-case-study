# Persistence and replay decisions

The brief requires only CSV input and output. SQLite adds a small, runnable way
to demonstrate database idempotency without an API, ORM, or external service.
Only Story 1 is implemented; no splits, review queue, or LLM categorization.

## Import invariants

- `transactions.id` is unique. `ledger_lines.transaction_id` is a primary key
  referencing that ID: one current source row and one classification per transaction.
- Source dates and amounts live in `transactions`; exports join them with the
  stored classification, avoiding another copy of those fields.
- An integer `position` preserves first-import order. Updates retain that position.
  Concurrent first imports are ordered by whichever process acquires the writer lock.
- Every row is validated before import. All source and classification writes for
  a file share one `BEGIN IMMEDIATE` transaction. A conflict or SQL failure rolls
  back the entire import, including earlier rows.

The importer groups rows by ID and considers the highest numeric batch in each
group. Under the database writer lock, it compares that version with stored state:

| Incoming version | Behavior |
| --- | --- |
| New ID | Insert source and classification |
| Higher batch | Update source and classification, keeping position |
| Equal batch, identical payload | No row writes |
| Equal batch, different payload | Fail and roll back the entire file |
| Lower batch | Ignore without writes |

The SQL upsert also has a `WHERE excluded.sync_batch > transactions.sync_batch`
guard. Uniqueness alone would prevent duplicate IDs but would not prevent an older
retry from overwriting a newer version. The lock covers both version checking
and writes, so competing importers cannot check the same stale state.

Payload equality covers date, account, merchant, memo, and the exact amount
string. Old versions are not retained: conflicts among superseded versions are
ignored, even if they appear together in the input. Invalid rows still reject the
file regardless of version. A same-batch payload conflict is checked only against
the highest relevant version, not against an audit history.

Import counts account for input rows: a winning version is inserted or updated
once, additional identical winning rows count as unchanged, and lower versions
count as stale. Counts sum to the number of input records on successful imports.
A header-only file performs no row writes and exports the current database.

## Database versus CSV recovery

First commit the import. Then start a second `BEGIN IMMEDIATE` transaction, read
the complete ledger snapshot, write a unique temporary file beside the output,
and rename it over the output. Keep the writer lock through file replacement.
This serializes exporters with importers and prevents a delayed exporter from
overwriting a newer snapshot for the same database. SQLite waits up to five seconds
for locks; a timeout exits with an error and can be retried.

The tool keeps SQLite's default journal mode. Changing a brand-new database to
WAL concurrently can fail during startup before the importer takes its lock;
avoiding that mode change keeps initialization under the same locking strategy.

| Failure point | Result / recovery |
| --- | --- |
| Invalid CSV, conflict, or SQL failure during import | No imported rows persist; existing CSV is unchanged |
| Process killed before import commit | SQLite rolls back uncommitted writes on recovery |
| After import commit, before CSV replacement | Database is current; previous CSV may be stale; rerun |
| Temporary-file write or rename failure | Import remains committed; rerun after fixing output access |
| After CSV rename | Complete committed snapshot is visible; replay remains safe |

Database and filesystem operations do not share a transaction. The CLI identifies
export failures after commit rather than claiming the import was rolled back.
Temporary files are cleaned up on ordinary errors; a hard crash may leave an
unused temporary file. Atomic replacement avoids partially visible CSV contents;
this is not a guarantee against filesystem or hardware failure. Independent
databases writing the same output path do not coordinate.

## Classification and scope assumptions

Merchant matching uses case-insensitive prefixes in the merchant field. Unknown
merchants require review; transfers override merchant classification. Negative
card amounts are refunds and negative bank amounts are deposits after transfers
are excluded. Zero, including negative zero, falls through to purchase. Decimal
money stays as text; no floating-point calculations are performed.

Per the supplied rule, either word `PAYMENT` or `TRANSFER` in the memo identifies
an internal transfer, ignoring case and regardless of account or amount sign.
The category is `Transfer` and `needs_review` is false. This includes the fixture
memo `ACH PAYMENT MAINLINE PROPERTIES`. Missing transfer legs are not invented
or paired.

CSV headers may arrive in any order but must contain exactly the seven declared
fields. Accounts must be `bank` or `card`, dates valid YYYY-MM-DD values, batches
nonnegative safe integers, and amounts signed decimal strings with at most two
fractional digits. Empty merchants and memos are allowed. The feed is loaded in
memory because this is a small dataset.

One database represents one operator and one provider ID namespace. Categorization
rules are fixed for this version: replay does not reclassify stored rows after a
code/rule change. Historical audit, rule migrations, automatic reconciliation,
multi-operator keys, and large-feed streaming would need separate requirements.

## Evidence

Tests check the first 15 expected lines and the complete 60-row feed, producing
56 current rows. Persistence tests verify uniqueness and foreign keys, no writes
on replay after reopening, numerical batch ordering, whole-import rollback after
a real trigger-induced SQL error between source and classification updates, and
unchanged first-import order. CLI tests run competing processes against a fresh
database, kill a writer during an uncommitted source update, and recover from a
post-commit export failure. No database behavior is mocked.
