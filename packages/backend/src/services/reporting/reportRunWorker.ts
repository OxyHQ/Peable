/**
 * The report run worker: pending runs become CSV files.
 *
 * Leased, not merely `SKIP LOCKED`: producing a report reads a whole interval
 * and makes an Oxy upload, neither bounded by this process, so a claim is held
 * across that work and outlives the transaction that took it. A worker that
 * dies leaves its lease to lapse; one that outlives it finds its completing
 * write gated on a token that is no longer its own, and writes nothing.
 *
 * Started per PROCESS by `server.ts` (N tasks share the queue through the
 * claim) and `.unref()`-ed like every loop here.
 *
 * ## What each outcome does
 *
 * - **Produced** — the CSV is stored as a `finance_report_run` File, then ONE
 *   transaction names it on the run and records
 *   `reporting.report_run.succeeded` (ADR 0014 D4: the event is written with
 *   the change).
 * - **Refused** (`ReportRunRefusedError`: too large, no ledger) — failed at
 *   once, with `reporting.report_run.failed`; retrying cannot help.
 * - **Anything else** (the database, Oxy Files) — the claim is deferred with a
 *   growing backoff, and the run fails after {@link MAX_ATTEMPTS}.
 *
 * A stored File whose run then could not be completed (the lease was lost) is
 * an unreferenced report nobody can name: harmless, private, and never served.
 */
import { getDb } from '../../db/postgres';
import { findFilesByIds } from '../../db/files/fileRepository';
import { findMerchantById } from '../../db/merchants/merchantRepository';
import {
  claimReportRun,
  completeReportRun,
  deferReportRun,
  failReportRun,
  type ClaimedReportRun,
} from '../../db/reporting/reportRunRepository';
import { outsideRequestContext } from '../../lib/requestContext';
import { toReportRunDTO } from '../../lib/serializeReporting';
import { recordEvent } from '../events';
import { createGeneratedFile } from '../files';
import { type OxyFilesClient, oxyFilesClient } from '../oxyFiles/client';
import { buildReport, ReportRunRefusedError, reportFilename } from './reports';

const LEASE_SECONDS = 10 * 60;
export const MAX_ATTEMPTS = 5;
const DEFAULT_INTERVAL_MS = 5_000;
/** Runs one tick may produce before yielding to the next. */
const RUNS_PER_TICK = 5;

export interface ReportRunWorkerDeps {
  readonly files?: OxyFilesClient;
}

export type ReportRunOutcome = 'idle' | 'succeeded' | 'failed' | 'deferred' | 'lost';

/** 30 s, 2 min, 8 min, … — a passing outage, not a hot loop. */
function backoffSeconds(attempts: number): number {
  return Math.min(30 * 4 ** Math.max(0, attempts - 1), 3600);
}

async function fail(run: ClaimedReportRun, message: string): Promise<ReportRunOutcome> {
  return getDb().transaction(async (tx) => {
    const failed = await failReportRun(tx, run, message);
    if (!failed) return 'lost';
    await recordEvent(tx, {
      merchantId: failed.merchantId,
      type: 'reporting.report_run.failed',
      object: toReportRunDTO(failed, null),
    });
    return 'failed';
  });
}

/** Claim one pending run and take it as far as it goes. */
export async function runReportRunPass(deps: ReportRunWorkerDeps = {}): Promise<ReportRunOutcome> {
  const db = getDb();
  const run = await claimReportRun(db, LEASE_SECONDS);
  if (run === null) return 'idle';
  if (run.attempts > MAX_ATTEMPTS) {
    return fail(run, 'the report could not be produced; create a new report run');
  }
  const merchant = await findMerchantById(db, run.merchantId);
  if (!merchant) return fail(run, 'the merchant of this report no longer exists');

  let file: Awaited<ReturnType<typeof createGeneratedFile>>;
  try {
    const bytes = await buildReport(run, merchant);
    file = await createGeneratedFile({
      files: deps.files ?? oxyFilesClient,
      merchant,
      purpose: 'finance_report_run',
      bytes,
      filename: reportFilename(run),
    });
  } catch (error) {
    if (error instanceof ReportRunRefusedError) return fail(run, error.message);
    process.emitWarning(
      `Peable report run ${run.publicId} attempt ${String(run.attempts)} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    if (run.attempts >= MAX_ATTEMPTS) {
      return fail(run, 'the report could not be produced; create a new report run');
    }
    await deferReportRun(db, run, backoffSeconds(run.attempts));
    return 'deferred';
  }

  return db.transaction(async (tx) => {
    const completed = await completeReportRun(tx, run, file.id);
    if (!completed) return 'lost';
    const [stored] = await findFilesByIds(tx, completed.merchantId, [file.id]);
    await recordEvent(tx, {
      merchantId: completed.merchantId,
      type: 'reporting.report_run.succeeded',
      object: toReportRunDTO(completed, stored ?? file),
    });
    return 'succeeded';
  });
}

/** Passes until the queue is empty or the tick's budget is spent. */
async function drain(deps: ReportRunWorkerDeps): Promise<void> {
  for (let i = 0; i < RUNS_PER_TICK; i += 1) {
    if ((await runReportRunPass(deps)) === 'idle') return;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let runningWith: ReportRunWorkerDeps | null = null;
let draining = false;

function tick(deps: ReportRunWorkerDeps): void {
  if (draining) return;
  draining = true;
  void drain(deps)
    .catch((error: unknown) => {
      process.emitWarning(
        `Peable report run tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      draining = false;
    });
}

export function startReportRunWorker(
  options: ReportRunWorkerDeps & { readonly intervalMs?: number } = {},
): void {
  if (timer !== null) return;
  runningWith = options;
  timer = setInterval(() => tick(options), options.intervalMs ?? DEFAULT_INTERVAL_MS);
  // Never the reason a process or a test run stays up.
  timer.unref?.();
}

export function stopReportRunWorker(): void {
  runningWith = null;
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Run a tick now — after a create, so a small report is ready in a second
 * rather than an interval. A no-op with no worker running: the run is durably
 * queued, so a missed kick costs latency, never the report.
 */
export function kickReportRunWorker(): void {
  const deps = runningWith;
  // Outside the request that kicked it: the run's events are the worker's,
  // `request: null`, whether this kick or the next interval produces them.
  if (deps !== null) outsideRequestContext(() => tick(deps));
}
