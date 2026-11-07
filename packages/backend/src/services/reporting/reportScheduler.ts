/**
 * The report scheduler: due schedules fire ordinary report runs.
 *
 * Each pass CLAIMS one due schedule (`claimDueReportSchedule`: one statement,
 * `for update skip locked`, its own lease token), computes the LATEST
 * occurrence at or before the database's now — a scheduler that was down
 * fires once for the newest occurrence it missed, never a backlog — and then,
 * in ONE transaction:
 *
 *  1. queues the occurrence's run through `enqueueReportRun`, the path
 *     `POST /v1/reporting/report_runs` takes, unique per (schedule,
 *     occurrence);
 *  2. moves `next_run_at` to the occurrence after it, gated on the lease token
 *     and on the schedule still being active.
 *
 * If the advance finds the claim gone (the lease lapsed and another task took
 * it, or the schedule was paused or canceled meanwhile) the transaction rolls
 * back and nothing fires. If the run already exists for that occurrence, the
 * schedule advances without a second run. The report run worker then produces
 * the CSV and, in its completion transaction, owes the recipients their email.
 *
 * Started per PROCESS by `server.ts` and `.unref()`-ed like every loop here.
 */
import { getDb } from '../../db/postgres';
import {
  advanceReportSchedule,
  type ClaimedReportSchedule,
  claimDueReportSchedule,
} from '../../db/reporting/reportScheduleRepository';
import { outsideRequestContext } from '../../lib/requestContext';
import { enqueueReportRun } from './reportRuns';
import { kickReportRunWorker } from './reportRunWorker';
import { dueOccurrence, intervalOf, type ScheduleCadence } from './scheduleCalendar';

/** Firing is one short transaction; a minute covers any pause in it. */
const LEASE_SECONDS = 60;
const DEFAULT_INTERVAL_MS = 30_000;
/** Schedules one tick may fire before yielding to the next. */
const FIRES_PER_TICK = 20;

export type ReportScheduleOutcome = 'idle' | 'fired' | 'lost';

export function cadenceOf(schedule: {
  readonly interval: ScheduleCadence['interval'];
  readonly weeklyAnchor: ScheduleCadence['weeklyAnchor'];
  readonly monthlyAnchor: ScheduleCadence['monthlyAnchor'];
}): ScheduleCadence {
  return {
    interval: schedule.interval,
    weeklyAnchor: schedule.weeklyAnchor,
    monthlyAnchor: schedule.monthlyAnchor,
  };
}

class ClaimLost extends Error {}

/** Fire one claimed schedule's due occurrence (exported for the race tests). */
export async function fireReportSchedule(
  schedule: ClaimedReportSchedule,
): Promise<ReportScheduleOutcome> {
  const cadence = cadenceOf(schedule);
  const { occurrence, next } = dueOccurrence(
    cadence,
    schedule.timezone,
    schedule.claimedAt.getTime(),
  );
  const interval = intervalOf(cadence, schedule.timezone, occurrence);
  try {
    await getDb().transaction(async (tx) => {
      await enqueueReportRun(
        tx,
        schedule.merchantId,
        {
          reportType: schedule.reportType,
          intervalStart: new Date(interval.start),
          intervalEnd: new Date(interval.end),
          columns: schedule.columns,
          currency: schedule.currency,
        },
        { id: schedule.id, occurrence: new Date(occurrence) },
      );
      if (!(await advanceReportSchedule(tx, schedule, new Date(next)))) throw new ClaimLost();
    });
  } catch (error) {
    if (error instanceof ClaimLost) return 'lost';
    throw error;
  }
  return 'fired';
}

/** Claim one due schedule and fire it. */
export async function runReportSchedulePass(): Promise<ReportScheduleOutcome> {
  const schedule = await claimDueReportSchedule(getDb(), LEASE_SECONDS);
  if (schedule === null) return 'idle';
  return fireReportSchedule(schedule);
}

async function drain(): Promise<void> {
  let fired = false;
  for (let i = 0; i < FIRES_PER_TICK; i += 1) {
    const outcome = await runReportSchedulePass();
    if (outcome === 'idle') break;
    if (outcome === 'fired') fired = true;
  }
  if (fired) kickReportRunWorker();
}

let timer: ReturnType<typeof setInterval> | null = null;
let draining = false;

function tick(): void {
  if (draining) return;
  draining = true;
  void outsideRequestContext(() => drain())
    .catch((error: unknown) => {
      process.emitWarning(
        `Peable report schedule tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      draining = false;
    });
}

export function startReportScheduler(options: { readonly intervalMs?: number } = {}): void {
  if (timer !== null) return;
  timer = setInterval(tick, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  // Never the reason a process or a test run stays up.
  timer.unref?.();
}

export function stopReportScheduler(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
