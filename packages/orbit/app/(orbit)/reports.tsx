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
import { Loading } from '@oxy.so/bloom/loading';
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
  intervalLabel,
  REPORT_FORM_ERRORS,
  type ReportRunForm,
  type ReportRunFormError,
  reportRunStatusLabel,
  reportRunStatusTone,
  reportTypeName,
} from '@/reports/runs';
import {
  downloadReportFile,
  reportKeys,
  useReportRuns,
  useReportTypes,
} from '@/reports/useReports';
import { Choice } from '@/ui/Choice';
import { FormField } from '@/ui/FormField';
import { ErrorNotice, MerchantMissing, OrbitScreen, Section } from '@/ui/OrbitScreen';

const ALL_CURRENCIES = 'all';
const CURRENCY_OPTIONS = [
  { value: ALL_CURRENCIES, label: t('reports.run.allCurrencies') },
  ...(Object.keys(ORBIT_CURRENCY_DECIMALS) as CurrencyCode[]).map((code) => ({
    value: code,
    label: code,
  })),
];

const firstOfMonth = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
};

/** A request and the `Idempotency-Key` it keeps until the gateway answers. */
interface PendingRequest {
  key: string;
  body: CreateReportRunParams;
}

function RunReport({ scope, types }: { scope: DashboardScope; types: readonly ReportType[] }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ReportRunForm>({
    reportType: types[0]?.id ?? '',
    start: firstOfMonth(),
    end: utcDay(nowSeconds()),
    currency: '',
  });
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

  const submit = () => {
    if (pending) {
      create.mutate(pending);
      return;
    }
    const result = buildReportRunBody(form, nowSeconds());
    setInvalid(result.ok ? null : result.error);
    if (!result.ok) return;
    const request = { key: Crypto.randomUUID(), body: result.body };
    setPending(request);
    create.mutate(request);
  };

  const selected = types.find((type) => type.id === form.reportType);
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
            options={CURRENCY_OPTIONS}
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
      <View className="flex-row flex-wrap gap-4">
        <View className="flex-1 min-w-56">
          <FormField
            label={t('reports.run.start')}
            value={form.start}
            onChange={(start) => setForm((prior) => ({ ...prior, start }))}
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
            onChange={(end) => setForm((prior) => ({ ...prior, end }))}
            invalid={hint(['end', 'order']) !== undefined}
            hint={hint(['end', 'order'])}
            disabled={locked}
          />
        </View>
      </View>
      {invalid === 'type' ? (
        <Text variant="caption-1-regular" className="text-destructive">
          {t(REPORT_FORM_ERRORS.type)}
        </Text>
      ) : null}
      <View className="flex-row justify-end">
        <Button appearance="solid" tone="accent" loading={create.isPending} onPress={submit}>
          {pending && !create.isPending ? t('reports.run.retry') : t('reports.run.submit')}
        </Button>
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
  if (types.isPending || runs.isPending) return <Loading accessibilityLabel={t('reports.title')} />;
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
  return (
    <View className="gap-6">
      <RunReport scope={scope} types={reportTypes} />
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
