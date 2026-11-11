<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Search and report runs (Orbit Phase 8)

**A search is the resource's LIST with a compiled predicate, never a second
reader.** `lib/search/parser.ts` parses Stripe's query language;
`lib/search/compile.ts` turns it into ONE parameterised predicate against the
resource's field registry (`db/search/searchFields.ts` — a field that is not
there does not exist); `lib/search/resources.ts` binds each resource to its
repository's own list function (`search?: SQL`) and serializer. Caller text only
ever enters SQL as a bound parameter (substring is `strpos`, not `LIKE`), and the
merchant predicate is the repository's. `routes/search.ts` is mounted BEFORE the
resource routers on both surfaces — `/v1/charges/search` must not reach
`/v1/charges/:id`. **Adding a resource is one fields map and one registry entry**
(plus `SEARCHABLE_RESOURCES` in shared-types) — `subscriptions` and `invoices`
(billing engine) were added that way; the parser, page token, routes, dashboard
box and SDK need nothing. The `page` token
is bound to its query and carries the keyset position, never the merchant.
No extensions: no `pg_trgm`, no full-text search.

**A report run is leased work.** `POST /v1/reporting/report_runs` writes a
`pending` row; `services/reporting/reportRunWorker.ts` (started in `server.ts`,
`.unref()`-ed) claims it in one statement (`for update skip locked`), builds the
CSV (`services/reporting/reports.ts`, the one place each column is computed),
stores it as a `finance_report_run` File, and completes the run AND records
`reporting.report_run.succeeded` in one transaction gated on its own
`lease_token`. A report file is Peable's output: never uploadable, private at
Oxy, readable only through `GET /v1/files/:id/contents`. The ledger reports read
the same ledger `GET /v1/balance` does (`services/money/ledgerScope.ts`).

**A report schedule fires ordinary runs, once per occurrence.**
`services/reporting/reportScheduler.ts` (started in `server.ts`, `.unref()`-ed)
claims a due `report_schedules` row in one statement (`for update skip
locked`, its own `lease_token`), takes the LATEST occurrence at or before the
database's now (`scheduleCalendar.ts`: local midnight in the schedule's IANA
zone, monthly anchors clamped; never a backlog), and in ONE transaction queues
the run through `enqueueReportRun` (`services/reporting/reportRuns.ts`, the path
`POST /v1/reporting/report_runs` takes) and advances `next_run_at`, gated on the
token and on `status = 'active'`. `report_runs (report_schedule_id,
scheduled_for)` is unique, so no race fires an occurrence twice. Never produce
a scheduled report anywhere but the run worker, and never give a schedule its
own CSV, column list or file. The recipients' emails are owed in the run's
completion transaction (`enqueueReportRunEmails`, deduplicated per run and
recipient) and LINK Orbit's Reports screen: a report file is private, so it is
never attached and never given a public URL. Writing a schedule is `configure`
in Orbit and `payments:write` on the API — it mails people in the merchant's
name.

**A run and a download are ONE report.** `GET /v1/reporting/report_types/:id/csv`
takes a run's `parameters` as a query and streams the same CSV: both pass
`admitReportRequest` (`routes/reporting.ts`) and both start from `openReport`
(`services/reporting/reports.ts`) — the layout's columns, their one computation, the
one reader per report and the one line renderer (`services/reporting/csv.ts`). A run
writes into memory under the file ceiling (`buildReport`); a download writes batches to
the socket, waiting on `drain` (`streamReport`), so its memory is a batch, not the
interval. Every refusal comes before the header row; a read that fails afterwards
DESTROYS the response (the error handler would `end()` it and a truncated file would
look complete). Never add a second CSV path or a second column list: a new report is a
layout in `REPORT_TYPE_LAYOUTS` (shared-types, browser-safe at
`@peable.to/shared-types/reporting`), its computations and reader here, and — because
`report_runs_report_type_check` is rendered from the ids — a migration. A column is
only ever appended to a version's `columns`; its `default_columns` never change.
