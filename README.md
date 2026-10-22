TypeScript, with SQLite persistence to demonstrate safe replay,
out-of-order syncs, and atomic database writes. No server required.

## Run

Requires Node.js 24+ and npm. From this folder:

```sh
npm install
npm start
```

By default, this imports the supplied `tests/fixtures/transactions.csv` and prints
only the exported ledger CSV in the terminal, alongside import/export status.
It also saves the ledger file as usual.

Or supply your own file and optional paths:

```sh
npm start -- /path/to/transactions.csv --db ledger.sqlite --out ledger_lines.csv
```

The default database is `ledger.sqlite`; the output is `ledger_lines.csv`.
Exports contain all stored transactions in first-import order. Use one database
per operator. Running the sample twice produces the same 56 lines;

To run testing suite `npm test`.

## Ambiguities

The case study doesn't mention using a db as a requirement and it is technically possible to meet all other requirements with out one, however, I know that knowledge of idempotency is a desire here, so for that reason I made sure to implement this using a low weight sqlite db.

## AI use

I used Codex heavily in both planning and implementation. I was very clear about the requirements and guidelines that I had in mind for this and worked alongside ensuring that all requirements were met.

If I had more time, there are some tests that I didn't fully audit, some could at least use a better naming convention that leads more clearly to which requirement it is testing for.
