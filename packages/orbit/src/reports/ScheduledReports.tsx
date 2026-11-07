import { useState } from 'react';
import { View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CurrencyCode,
  ReportSchedule,
  ReportScheduleInterval,
  ReportScheduleLocale,
  ReportScheduleWeekday,
  ReportType,
  ReportTypeId,
} from '@peable.to/shared-types';
import { REPORT_SCHEDULE_MAX_RECIPIENTS } from '@peable.to/shared-types/reporting';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { AlertDialog } from '@oxy.so/bloom/alert-dialog';
import { Badge } from '@oxy.so/bloom/badge';
import { Button, LinkButton } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@oxy.so/bloom/table';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { describeError, isOrbitApiError } from '@/api/transport';
import { ORBIT_CURRENCY_DECIMALS } from '@/format/money';
import { formatInstant } from '@/format/time';
import { getLocale, t } from '@/i18n';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { reportTypeName } from '@/reports/runs';
import {
  buildReportScheduleBody,
  cadenceLabel,
  emptyScheduleForm,
  type ReportScheduleForm,
  type ReportScheduleFormError,
  SCHEDULE_FORM_ERRORS,
  scheduleActions,
  scheduleForm,
  scheduleStatusLabel,
  scheduleStatusTone,
  WEEKDAYS,
  weekdayLabel,
} from '@/reports/schedules';
import { reportKeys } from '@/reports/useReports';
import { Choice } from '@/ui/Choice';
import { FormField } from '@/ui/FormField';
import { Section } from '@/ui/OrbitScreen';

const ALL_CURRENCIES = 'all';
const currencyOptions = () => [
  { value: ALL_CURRENCIES, label: t('reports.run.allCurrencies') },
  ...(Object.keys(ORBIT_CURRENCY_DECIMALS) as CurrencyCode[]).map((code) => ({
    value: code,
    label: code,
  })),
];
const INTERVALS: readonly ReportScheduleInterval[] = ['daily', 'weekly', 'monthly'];
const LANGUAGES: readonly ReportScheduleLocale[] = ['en', 'es'];

type ColumnSet = 'default' | 'all';

/** A save and the `Idempotency-Key` it keeps until the gateway answers. */
interface PendingSave {
  key: string;
  run: () => Promise<ReportSchedule>;
}

/**
 * Create or edit a schedule. The form keeps one `Idempotency-Key` per request
 * until the gateway answers it, so retrying an unknown outcome never makes a
 * second schedule.
 */
function ScheduleForm({
  scope,
  types,
  editing,
  onDone,
}: {
  scope: DashboardScope;
  types: readonly ReportType[];
  /** The schedule being edited; `null` creates one. */
  editing: ReportSchedule | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ReportScheduleForm>(() =>
    editing ? scheduleForm(editing) : emptyScheduleForm(types[0]?.id ?? '', getLocale()),
  );
  const [columnSet, setColumnSet] = useState<ColumnSet>(() =>
    editing?.parameters.columns ? 'all' : 'default',
  );
  const [invalid, setInvalid] = useState<ReportScheduleFormError | null>(null);
  const [pending, setPending] = useState<PendingSave | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = types.find((type) => type.id === form.reportType);

  const save = useMutation({
    mutationFn: (request: PendingSave) => request.run(),
    onSuccess: (schedule) => {
      setPending(null);
      setError(null);
      toast.success(
        editing
          ? t('reports.schedules.saved')
          : t('reports.schedules.created', { date: formatInstant(schedule.next_run_at) }),
      );
      void queryClient.invalidateQueries({ queryKey: reportKeys.schedules(scope) });
      onDone();
    },
    onError: (failure) => {
      setError(describeError(failure, t('reports.schedules.saveFailed')));
      // An answer means the gateway decided; only an unknown outcome keeps the key.
      if (isOrbitApiError(failure) && failure.status > 0 && failure.status < 500) setPending(null);
    },
  });

  const submit = () => {
    if (pending) {
      save.mutate(pending);
      return;
    }
    const result = buildReportScheduleBody(
      columnSet === 'all' && selected
        ? { ...form, columns: selected.columns }
        : { ...form, columns: undefined },
    );
    setInvalid(result.ok ? null : result.error);
    if (!result.ok) return;
    const key = Crypto.randomUUID();
    const body = result.body;
    const request: PendingSave = {
      key,
      run: () =>
        editing
          ? dashboardApi.reporting.schedules.update(scope, editing.id, body, key)
          : dashboardApi.reporting.schedules.create(scope, body, key),
    };
    setPending(request);
    save.mutate(request);
  };

  const locked = pending !== null || save.isPending;
  const hint = (field: ReportScheduleFormError[]) =>
    invalid !== null && field.includes(invalid)
      ? t(SCHEDULE_FORM_ERRORS[invalid], { max: String(REPORT_SCHEDULE_MAX_RECIPIENTS) })
      : undefined;
  const update = (patch: Partial<ReportScheduleForm>) =>
    setForm((prior) => ({ ...prior, ...patch }));

  return (
    <View className="gap-4 rounded-lg border border-border p-4">
      <Text variant="body-medium">
        {editing ? t('reports.schedules.form.editTitle') : t('reports.schedules.form.createTitle')}
      </Text>
      {error ? (
        <Admonition type="error">
          <AdmonitionText>{error}</AdmonitionText>
        </Admonition>
      ) : null}
      <View className="flex-row flex-wrap gap-4">
        <View className="w-64">
          <Choice
            label={t('reports.run.type')}
            value={form.reportType || null}
            options={types.map((type) => ({ value: type.id, label: type.name }))}
            disabled={locked}
            onChange={(reportType) => update({ reportType: reportType as ReportTypeId })}
          />
        </View>
        <View className="w-56">
          <Choice
            label={t('reports.run.currency')}
            value={form.currency || ALL_CURRENCIES}
            options={currencyOptions()}
            disabled={locked}
            onChange={(currency) =>
              update({ currency: currency === ALL_CURRENCIES ? '' : (currency as CurrencyCode) })
            }
          />
        </View>
      </View>
      {invalid === 'type' ? (
        <Text variant="caption-1-regular" className="text-destructive">
          {t(SCHEDULE_FORM_ERRORS.type)}
        </Text>
      ) : null}
      <View className="gap-1.5">
        <Text variant="caption-1-medium" className="text-muted-foreground">
          {t('reports.run.columns')}
        </Text>
        <SegmentedControl<ColumnSet>
          label={t('reports.run.columns')}
          type="radio"
          size="sm"
          value={columnSet}
          disabled={locked}
          onValueChange={setColumnSet}
        >
          {(['default', 'all'] as const).map((value) => (
            <SegmentedControlItem key={value} value={value}>
              <SegmentedControlItemText>
                {t(`reports.run.columns.${value}`)}
              </SegmentedControlItemText>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </View>
      <View className="gap-1.5">
        <Text variant="caption-1-medium" className="text-muted-foreground">
          {t('reports.schedules.form.cadence')}
        </Text>
        <SegmentedControl<ReportScheduleInterval>
          label={t('reports.schedules.form.cadence')}
          type="radio"
          size="sm"
          value={form.interval}
          disabled={locked}
          onValueChange={(interval) => update({ interval })}
        >
          {INTERVALS.map((interval) => (
            <SegmentedControlItem key={interval} value={interval}>
              <SegmentedControlItemText>
                {cadenceLabel({
                  interval,
                  weekly_anchor: interval === 'weekly' ? form.weeklyAnchor : null,
                  monthly_anchor: interval === 'monthly' ? Number(form.monthlyAnchor) || 1 : null,
                })}
              </SegmentedControlItemText>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </View>
      <View className="flex-row flex-wrap gap-4">
        {form.interval === 'weekly' ? (
          <View className="w-56">
            <Choice
              label={t('reports.schedules.form.weekday')}
              value={form.weeklyAnchor}
              options={WEEKDAYS.map((day) => ({ value: day, label: weekdayLabel(day) }))}
              disabled={locked}
              onChange={(day) => update({ weeklyAnchor: day as ReportScheduleWeekday })}
            />
          </View>
        ) : null}
        {form.interval === 'monthly' ? (
          <View className="w-56">
            <FormField
              label={t('reports.schedules.form.monthDay')}
              value={form.monthlyAnchor}
              onChange={(monthlyAnchor) => update({ monthlyAnchor })}
              keyboardType="number-pad"
              invalid={hint(['monthlyAnchor']) !== undefined}
              hint={hint(['monthlyAnchor']) ?? t('reports.schedules.form.monthDayHint')}
              disabled={locked}
            />
          </View>
        ) : null}
        <View className="flex-1 min-w-56">
          <FormField
            label={t('reports.schedules.form.timezone')}
            value={form.timezone}
            onChange={(timezone) => update({ timezone })}
            invalid={hint(['timezone']) !== undefined}
            hint={hint(['timezone']) ?? t('reports.schedules.form.timezoneHint')}
            disabled={locked}
          />
        </View>
      </View>
      <FormField
        label={t('reports.schedules.form.recipients')}
        value={form.recipients}
        onChange={(recipients) => update({ recipients })}
        placeholder="finance@example.com, accountant@example.com"
        keyboardType="email-address"
        multiline
        invalid={hint(['recipient', 'duplicateRecipient', 'tooManyRecipients']) !== undefined}
        hint={
          hint(['recipient', 'duplicateRecipient', 'tooManyRecipients']) ??
          t('reports.schedules.form.recipientsHint', {
            max: String(REPORT_SCHEDULE_MAX_RECIPIENTS),
          })
        }
        disabled={locked}
      />
      <View className="w-56">
        <Choice
          label={t('reports.schedules.form.language')}
          value={form.locale}
          options={LANGUAGES.map((language) => ({
            value: language,
            label: t(`reports.schedules.form.language.${language}`),
          }))}
          disabled={locked}
          onChange={(locale) => update({ locale: locale as ReportScheduleLocale })}
        />
      </View>
      <View className="flex-row flex-wrap justify-end gap-2">
        <Button appearance="outline" tone="accent" disabled={save.isPending} onPress={onDone}>
          {t('reports.schedules.form.close')}
        </Button>
        <Button appearance="solid" tone="accent" loading={save.isPending} onPress={submit}>
          {pending && !save.isPending
            ? t('reports.schedules.form.retry')
            : editing
              ? t('reports.schedules.form.save')
              : t('reports.schedules.form.create')}
        </Button>
      </View>
    </View>
  );
}

const COLUMNS = {
  report: { flex: 3, minWidth: 180 },
  cadence: { flex: 3, minWidth: 180 },
  recipients: { flex: 3, minWidth: 200 },
  status: { flex: 2, minWidth: 120 },
  next: { flex: 3, minWidth: 200 },
  actions: { flex: 4, minWidth: 260 },
} as const;

type Action = 'pause' | 'resume' | 'cancel';

/**
 * The Scheduled reports section: the merchant's schedules, their actions,
 * and the form that creates or edits one.
 *
 * Writing a schedule is `configure`, not `read` like a one-off run: a schedule
 * is standing configuration of the application that keeps producing runs and
 * mails people in the merchant's name. Reading schedules is `read`.
 */
export function ScheduledReports({
  scope,
  types,
  schedules,
  showingRunsOf,
  onShowRuns,
}: {
  scope: DashboardScope;
  types: readonly ReportType[];
  schedules: readonly ReportSchedule[];
  /** The schedule whose runs the list below shows; `null` for every run. */
  showingRunsOf: string | null;
  onShowRuns: (scheduleId: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const mayConfigure = can('configure');
  const [editing, setEditing] = useState<ReportSchedule | 'new' | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<ReportSchedule | null>(null);
  /** Per schedule, the action in flight and its key, kept until the gateway answers. */
  const [pendingKeys, setPendingKeys] = useState<Record<string, string>>({});

  const act = useMutation({
    mutationFn: ({ schedule, action }: { schedule: ReportSchedule; action: Action }) => {
      const slot = `${schedule.id}:${action}`;
      const key = pendingKeys[slot] ?? Crypto.randomUUID();
      setPendingKeys((prior) => ({ ...prior, [slot]: key }));
      return dashboardApi.reporting.schedules.act(scope, schedule.id, action, key);
    },
    onSuccess: (_schedule, { schedule, action }) => {
      setPendingKeys((prior) => {
        const { [`${schedule.id}:${action}`]: _done, ...rest } = prior;
        return rest;
      });
      toast.success(
        t(
          action === 'pause'
            ? 'reports.schedules.paused'
            : action === 'resume'
              ? 'reports.schedules.resumed'
              : 'reports.schedules.canceled',
        ),
      );
      void queryClient.invalidateQueries({ queryKey: reportKeys.schedules(scope) });
    },
    onError: (failure, { schedule, action }) => {
      if (isOrbitApiError(failure) && failure.status > 0 && failure.status < 500) {
        setPendingKeys((prior) => {
          const { [`${schedule.id}:${action}`]: _done, ...rest } = prior;
          return rest;
        });
      }
      toast.error(describeError(failure, t('reports.schedules.actionFailed')));
    },
  });

  return (
    <Section title={t('reports.schedules.title')} description={t('reports.schedules.intro')}>
      {mayConfigure ? null : (
        <Admonition type="info">
          <AdmonitionText>{t('reports.schedules.configureOnly')}</AdmonitionText>
        </Admonition>
      )}
      {editing !== null ? (
        <ScheduleForm
          key={editing === 'new' ? 'new' : editing.id}
          scope={scope}
          types={types}
          editing={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      ) : (
        <View className="flex-row justify-end">
          <Button
            appearance="solid"
            tone="accent"
            disabled={!mayConfigure}
            onPress={() => setEditing('new')}
          >
            {t('reports.schedules.new')}
          </Button>
        </View>
      )}
      <Table accessibilityLabel={t('reports.schedules.title')} minWidth={1100}>
        <TableHeader>
          <TableColumn {...COLUMNS.report}>{t('reports.schedules.column.report')}</TableColumn>
          <TableColumn {...COLUMNS.cadence}>{t('reports.schedules.column.cadence')}</TableColumn>
          <TableColumn {...COLUMNS.recipients}>
            {t('reports.schedules.column.recipients')}
          </TableColumn>
          <TableColumn {...COLUMNS.status}>{t('reports.schedules.column.status')}</TableColumn>
          <TableColumn {...COLUMNS.next}>{t('reports.schedules.column.next')}</TableColumn>
          <TableColumn {...COLUMNS.actions}> </TableColumn>
        </TableHeader>
        <TableBody
          emptyState={
            <EmptyState
              variant="compact"
              title={t('reports.schedules.empty.title')}
              description={t('reports.schedules.empty.body')}
            />
          }
        >
          {schedules.map((schedule) => (
            <TableRow key={schedule.id}>
              <TableCell {...COLUMNS.report}>
                {`${reportTypeName(types, schedule.report_type)}${
                  schedule.parameters.currency ? ` · ${schedule.parameters.currency}` : ''
                }`}
              </TableCell>
              <TableCell {...COLUMNS.cadence}>{cadenceLabel(schedule.schedule)}</TableCell>
              <TableCell {...COLUMNS.recipients}>
                {schedule.recipients.length > 0
                  ? schedule.recipients.join(', ')
                  : t('reports.schedules.noRecipients')}
              </TableCell>
              <TableCell {...COLUMNS.status}>
                <Badge
                  appearance="subtle"
                  tone={scheduleStatusTone(schedule.status)}
                  size="label-small"
                  content={scheduleStatusLabel(schedule.status)}
                />
              </TableCell>
              <TableCell {...COLUMNS.next}>
                {schedule.next_run_at === null
                  ? '—'
                  : t('reports.schedules.timezone', {
                      time: formatInstant(schedule.next_run_at),
                      zone: schedule.timezone,
                    })}
              </TableCell>
              <TableCell {...COLUMNS.actions}>
                <View className="flex-row flex-wrap gap-2">
                  {scheduleActions(schedule.status).map((action) => (
                    <LinkButton
                      key={action}
                      size="sm"
                      disabled={!mayConfigure || act.isPending}
                      accessibilityLabel={`${t(`reports.schedules.action.${action}`)} ${schedule.id}`}
                      onPress={() => {
                        if (action === 'edit') setEditing(schedule);
                        else if (action === 'cancel') setConfirmCancel(schedule);
                        else act.mutate({ schedule, action });
                      }}
                    >
                      {t(`reports.schedules.action.${action}`)}
                    </LinkButton>
                  ))}
                  <LinkButton
                    size="sm"
                    onPress={() => onShowRuns(showingRunsOf === schedule.id ? null : schedule.id)}
                  >
                    {showingRunsOf === schedule.id
                      ? t('reports.schedules.action.allRuns')
                      : t('reports.schedules.action.runs')}
                  </LinkButton>
                </View>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <AlertDialog
        open={confirmCancel !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmCancel(null);
        }}
        title={t('reports.schedules.confirmCancel.title')}
        description={t('reports.schedules.confirmCancel.body')}
        confirmLabel={t('reports.schedules.confirmCancel.action')}
        cancelLabel={t('reports.schedules.confirmCancel.keep')}
        destructive
        onConfirm={() => {
          const schedule = confirmCancel;
          setConfirmCancel(null);
          if (schedule) act.mutate({ schedule, action: 'cancel' });
        }}
        onCancel={() => setConfirmCancel(null)}
      />
    </Section>
  );
}
