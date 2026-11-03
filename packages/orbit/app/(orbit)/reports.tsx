import { useState } from 'react';
import { View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CreateReportRunParams,
  CurrencyCode,
  ReportRun,
  ReportType,
  ReportTypeId,
} from '@peable.to/shared-types';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
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
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { describeError, isOrbitApiError } from '@/api/transport';
import { ORBIT_CURRENCY_DECIMALS } from '@/format/money';
import { formatInstant, nowSeconds, utcDay } from '@/format/time';
import { t } from '@/i18n';
import {
  buildReportRunBody,
  downloadableFile,
  downloadFilename,
  intervalLabel,
  presetDays,
  REPORT_FORM_ERRORS,
  REPORT_PRESETS,
  type ReportPreset,
  type ReportRunForm,
  type ReportRunFormError,
  reportRunStatusLabel,
  reportRunStatusTone,
  reportTypeName,
} from '@/reports/runs';
import {
  canSaveFiles,
  downloadReportFile,
  downloadReportNow,
  reportKeys,
  useReportRuns,
  useReportTypes,
} from '@/reports/useReports';
import { Choice } from '@/ui/Choice';
import { FormField } from '@/ui/FormField';
import { ErrorNotice, MerchantMissing, OrbitScreen, Section } from '@/ui/OrbitScreen';
import { PageSkeleton } from '@/ui/states';

const ALL_CURRENCIES = 'all';
// Built at render: the language can change while Orbit is open.
const currencyOptions = () => [
  { value: ALL_CURRENCIES, label: t('reports.run.allCurrencies') },
  ...(Object.keys(ORBIT_CURRENCY_DECIMALS) as CurrencyCode[]).map((code) => ({
    value: code,
    label: code,
  })),
];

type Period = ReportPreset | 'custom';
type ColumnSet = 'default' | 'all';

/** A request and the `Idempotency-Key` it keeps until the gateway answers. */
interface PendingRequest {
  key: string;
  body: CreateReportRunParams;
}

/**
 * One form for both ways of getting a report — the same request either way:
 * **Download now** streams the CSV at once; **Run and keep** produces it in the
 * background and lists it below with its file.
 */
function GetReport({
  scope,
  types,
  form,
  setForm,
}: {
  scope: DashboardScope;
  types: readonly ReportType[];
  form: ReportRunForm;
  setForm: (update: (prior: ReportRunForm) => ReportRunForm) => void;
}) {
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<Period>('thisMonth');
  const [columnSet, setColumnSet] = useState<ColumnSet>('default');
  const [invalid, setInvalid] = useState<ReportRunFormError | null>(null);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (request: PendingRequest) =>
      dashboardApi.reporting.create(scope, request.body, request.key),
    onSuccess: () => {
      setPending(null);
      setError(null);
      toast.success(t('reports.run.created'));
      void queryClient.invalidateQueries({ queryKey: reportKeys.runs(scope) });
    },
    onError: (failure) => {
      setError(describeError(failure, t('error.generic')));
      // An answer means the gateway decided; only an unknown outcome keeps the key.
      if (isOrbitApiError(failure) && failure.status > 0 && failure.status < 500) setPending(null);
    },
  });

  const selected = types.find((type) => type.id === form.reportType);
  /** The form as a request: the columns of the set chosen, from the report type itself. */
  const request = () =>
    buildReportRunBody(
      columnSet === 'all' && selected ? { ...form, columns: selected.columns } : form,
      nowSeconds(),
    );

  const download = useMutation({
    mutationFn: (body: CreateReportRunParams) =>
      downloadReportNow(scope, body, downloadFilename(form)),
    onSuccess: (saved) => {
      setError(null);
      if (saved) toast.success(t('reports.run.downloaded'));
      else toast.error(t('reports.downloadWebOnly'));
    },
    onError: (failure) => setError(describeError(failure, t('reports.downloadFailed'))),
  });

  const submit = () => {
    if (pending) {
      create.mutate(pending);
      return;
    }
    const result = request();
    setInvalid(result.ok ? null : result.error);
    if (!result.ok) return;
    const pendingRequest = { key: Crypto.randomUUID(), body: result.body };
    setPending(pendingRequest);
    create.mutate(pendingRequest);
  };

  const downloadNow = () => {
    const result = request();
    setInvalid(result.ok ? null : result.error);
    if (result.ok) download.mutate(result.body);
  };

  const choosePeriod = (value: Period) => {
    setPeriod(value);
    if (value !== 'custom') setForm((prior) => ({ ...prior, ...presetDays(value, nowSeconds()) }));
  };
  const locked = pending !== null || create.isPending;
  const hint = (field: ReportRunFormError[]) =>
    invalid !== null && field.includes(invalid) ? t(REPORT_FORM_ERRORS[invalid]) : undefined;

  return (
    <Section title={t('reports.run.title')} description={t('reports.run.intro')}>
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
            onChange={(reportType) =>
              setForm((prior) => ({ ...prior, reportType: reportType as ReportTypeId }))
            }
          />
        </View>
        <View className="w-56">
          <Choice
            label={t('reports.run.currency')}
            value={form.currency || ALL_CURRENCIES}
            options={currencyOptions()}
            disabled={locked}
            onChange={(currency) =>
              setForm((prior) => ({
                ...prior,
                currency: currency === ALL_CURRENCIES ? '' : (currency as CurrencyCode),
              }))
            }
          />
        </View>
      </View>
      <View className="gap-1.5">
        <Text variant="caption-1-medium" className="text-muted-foreground">
          {t('reports.run.period')}
        </Text>
        <SegmentedControl<Period>
          label={t('reports.run.period')}
          type="radio"
          size="sm"
          value={period}
          disabled={locked}
          onValueChange={choosePeriod}
        >
          {[...REPORT_PRESETS, 'custom' as const].map((value) => (
            <SegmentedControlItem key={value} value={value}>
              <SegmentedControlItemText>{t(`reports.preset.${value}`)}</SegmentedControlItemText>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </View>
      <View className="flex-row flex-wrap gap-4">
        <View className="flex-1 min-w-56">
          <FormField
            label={t('reports.run.start')}
            value={form.start}
            onChange={(start) => {
              setPeriod('custom');
              setForm((prior) => ({ ...prior, start }));
            }}
            invalid={hint(['start', 'future']) !== undefined}
            hint={
              hint(['start', 'future']) ??
              (selected
                ? t('reports.run.available', { date: utcDay(selected.data_available_start) })
                : undefined)
            }
            disabled={locked}
          />
        </View>
        <View className="flex-1 min-w-56">
          <FormField
            label={t('reports.run.end')}
            value={form.end}
            onChange={(end) => {
              setPeriod('custom');
              setForm((prior) => ({ ...prior, end }));
            }}
            invalid={hint(['end', 'order']) !== undefined}
            hint={hint(['end', 'order'])}
            disabled={locked}
          />
        </View>
      </View>
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
      {invalid === 'type' ? (
        <Text variant="caption-1-regular" className="text-destructive">
          {t(REPORT_FORM_ERRORS.type)}
        </Text>
      ) : null}
      {canSaveFiles() ? null : (
        <Admonition type="info">
          <AdmonitionText>{t('reports.downloadWebOnly')}</AdmonitionText>
        </Admonition>
      )}
      <View className="flex-row flex-wrap justify-end gap-2">
        <Button
          appearance="outline"
          tone="accent"
          loading={download.isPending}
          disabled={locked || !canSaveFiles()}
          onPress={downloadNow}
        >
          {t('reports.run.download')}
        </Button>
        <Button appearance="solid" tone="accent" loading={create.isPending} onPress={submit}>
          {pending && !create.isPending ? t('reports.run.retry') : t('reports.run.submit')}
        </Button>
      </View>
    </Section>
  );
}

/** The selected report's columns (defaults marked) and the cell rules every report follows. */
function ReportColumns({ type }: { type: ReportType | undefined }) {
  if (!type) return null;
  const defaults = new Set(type.default_columns);
  return (
    <Section
      title={t('reports.columns.title', { report: type.name })}
      description={t('reports.columns.intro')}
    >
      <View className="flex-row flex-wrap gap-2">
        {type.columns.map((column) => (
          <Text
            key={column}
            variant="caption-1-regular"
            selectable
            className={`font-mono rounded-md border px-2 py-1 ${
              defaults.has(column) ? 'border-primary' : 'border-border text-muted-foreground'
            }`}
          >
            {defaults.has(column) ? `${column} · ${t('reports.columns.default')}` : column}
          </Text>
        ))}
      </View>
      <View className="gap-1">
        {(['amounts', 'instants', 'unknown', 'text', 'format'] as const).map((rule) => (
          <Text key={rule} variant="body-2-regular" className="text-muted-foreground">
            {`• ${t(`reports.rule.${rule}`)}`}
          </Text>
        ))}
      </View>
    </Section>
  );
}

const COLUMNS = {
  report: { flex: 3, minWidth: 180 },
  interval: { flex: 3, minWidth: 200 },
  status: { flex: 3, minWidth: 200 },
  created: { flex: 2, minWidth: 160 },
  file: { flex: 2, minWidth: 150 },
} as const;

function DownloadCell({ scope, run }: { scope: DashboardScope; run: ReportRun }) {
  const [busy, setBusy] = useState(false);
  const file = downloadableFile(run);
  if (run.status !== 'succeeded') return null;
  if (!file) {
    return (
      <Text variant="caption-1-regular" className="text-muted-foreground">
        {t('reports.unavailable')}
      </Text>
    );
  }
  return (
    <LinkButton
      size="sm"
      disabled={busy}
      accessibilityLabel={`${t('reports.download')} ${run.id}`}
      onPress={() => {
        setBusy(true);
        downloadReportFile(scope, file)
          .then((saved) => {
            if (!saved) toast.error(t('reports.downloadWebOnly'));
          })
          .catch((failure: unknown) =>
            toast.error(describeError(failure, t('reports.downloadFailed'))),
          )
          .finally(() => setBusy(false));
      }}
    >
      {t('reports.download')}
    </LinkButton>
  );
}

function RunsTable({
  scope,
  runs,
  types,
}: {
  scope: DashboardScope;
  runs: readonly ReportRun[];
  types: readonly ReportType[];
}) {
  return (
    <Table accessibilityLabel={t('reports.list')} minWidth={900}>
      <TableHeader>
        <TableColumn {...COLUMNS.report}>{t('reports.column.report')}</TableColumn>
        <TableColumn {...COLUMNS.interval}>{t('reports.column.interval')}</TableColumn>
        <TableColumn {...COLUMNS.status}>{t('reports.column.status')}</TableColumn>
        <TableColumn {...COLUMNS.created}>{t('reports.column.created')}</TableColumn>
        <TableColumn {...COLUMNS.file}> </TableColumn>
      </TableHeader>
      <TableBody
        emptyState={
          <EmptyState
            variant="compact"
            title={t('reports.empty.title')}
            description={t('reports.empty.body')}
          />
        }
      >
        {runs.map((run) => (
          <TableRow key={run.id}>
            <TableCell {...COLUMNS.report}>
              {`${reportTypeName(types, run.report_type)}${
                run.parameters.currency ? ` · ${run.parameters.currency}` : ''
              }`}
            </TableCell>
            <TableCell {...COLUMNS.interval}>{intervalLabel(run)}</TableCell>
            <TableCell {...COLUMNS.status}>
              <View className="gap-1">
                <Badge
                  appearance="subtle"
                  tone={reportRunStatusTone(run.status)}
                  size="label-small"
                  content={reportRunStatusLabel(run.status)}
                />
                {run.error ? (
                  <Text variant="caption-1-regular" className="text-muted-foreground">
                    {run.error}
                  </Text>
                ) : null}
              </View>
            </TableCell>
            <TableCell {...COLUMNS.created}>{formatInstant(run.created)}</TableCell>
            <TableCell {...COLUMNS.file}>
              <DownloadCell scope={scope} run={run} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Reports({ scope }: { scope: DashboardScope }) {
  const types = useReportTypes(scope);
  const runs = useReportRuns(scope);
  const [form, setForm] = useState<ReportRunForm>(() => ({
    reportType: '',
    ...presetDays('thisMonth', nowSeconds()),
    currency: '',
  }));
  if (types.isPending || runs.isPending)
    return <PageSkeleton variant="table" accessibilityLabel={t('reports.title')} />;
  const failure = types.error ?? runs.error;
  if (failure) {
    if (isMerchantMissing(failure)) return <MerchantMissing environment={scope.environment} />;
    return (
      <ErrorNotice
        error={failure}
        onRetry={() => {
          void types.refetch();
          void runs.refetch();
        }}
      />
    );
  }
  const reportTypes = types.data?.data ?? [];
  const current = form.reportType === '' ? { ...form, reportType: reportTypes[0]?.id ?? '' } : form;
  return (
    <View className="gap-6">
      <GetReport
        scope={scope}
        types={reportTypes}
        form={current}
        setForm={(update) => setForm(() => update(current))}
      />
      <ReportColumns type={reportTypes.find((type) => type.id === current.reportType)} />
      <Section title={t('reports.list')}>
        <RunsTable scope={scope} runs={runs.data?.data ?? []} types={reportTypes} />
      </Section>
    </View>
  );
}

export default function ReportsScreen() {
  return (
    <OrbitScreen title={t('reports.title')} description={t('reports.description')}>
      {({ scope }) => <Reports key={`${scope.applicationId}:${scope.environment}`} scope={scope} />}
    </OrbitScreen>
  );
}
