import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { VerificationReport, VerificationSession } from '@peable.to/shared-types';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { AlertDialog } from '@oxy.so/bloom/alert-dialog';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope, VerificationSessionAction } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { labelFor, t } from '@/i18n';
import {
  CheckStatusBadge,
  HostedLink,
  identityErrorMessage,
  VerificationStatusBadge,
} from '@/identity/IdentityParts';
import {
  hostedLinkOf,
  redactWaitsForProcessing,
  verificationActions,
} from '@/identity/identityForm';
import {
  identityKeys,
  useVerificationReports,
  useVerificationSession,
} from '@/identity/useIdentity';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { Timestamp } from '@/ui/data';
import {
  DetailHeader,
  DetailLayout,
  ErrorNotice,
  Field,
  OrbitScreen,
  Section,
} from '@/ui/OrbitScreen';
import { isNotFound, NotFound, PageSkeleton, PermissionNotice } from '@/ui/states';

function Actions({ scope, session }: { scope: DashboardScope; session: VerificationSession }) {
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const [confirming, setConfirming] = useState<VerificationSessionAction | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: identityKeys.all(scope) });
  const act = useMutation({
    mutationFn: (action: VerificationSessionAction) =>
      dashboardApi.identity.sessions.act(scope, session.id, action),
    onSuccess: (_updated, action) => {
      toast.success(t(`verification.done.${action}`));
      refresh();
    },
    onError: (error) => {
      toast.error(identityErrorMessage(error));
      // A refusal for a session that moved: show where it stands now.
      refresh();
    },
  });
  const actions = verificationActions(session);
  const waits = redactWaitsForProcessing(session);
  if (actions.length === 0 && !waits) return null;
  const allowed = can('money');
  return (
    <View className="gap-3">
      <PermissionNotice action="money" />
      <View className="flex-row flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action}
            appearance="outline"
            tone="danger"
            size="sm"
            loading={act.isPending && act.variables === action}
            disabled={!allowed || act.isPending}
            onPress={() => setConfirming(action)}
          >
            {t(`verification.action.${action}`)}
          </Button>
        ))}
      </View>
      {waits ? (
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {t('verification.redactWaits')}
        </Text>
      ) : null}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t(
          confirming === 'redact'
            ? 'verification.confirmRedact.title'
            : 'verification.confirmCancel.title',
        )}
        description={t(
          confirming === 'redact'
            ? 'verification.confirmRedact.body'
            : 'verification.confirmCancel.body',
        )}
        confirmLabel={t(
          confirming === 'redact'
            ? 'verification.confirmRedact.action'
            : 'verification.confirmCancel.action',
        )}
        cancelLabel={t('verification.confirm.keep')}
        destructive
        onConfirm={() => {
          const action = confirming;
          setConfirming(null);
          if (action) act.mutate(action);
        }}
      />
    </View>
  );
}

const CHECKS = ['document', 'id_number', 'selfie'] as const;

function ReportRow({ report }: { report: VerificationReport }) {
  return (
    <View className="gap-2 py-3 border-b border-border">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text variant="body-2-semibold" selectable className="font-mono">
          {t('verification.report', { id: report.id })}
        </Text>
        <Timestamp seconds={report.created} muted />
      </View>
      {CHECKS.map((check) => {
        const outcome = report[check];
        if (outcome === null) return null;
        return (
          <View key={check} className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
            <Text variant="body-2-medium" className="min-w-32">
              {t(`verification.check.${check}`)}
            </Text>
            <CheckStatusBadge status={outcome.status} />
            {outcome.error ? (
              <Text variant="caption-1-regular" className="text-muted-foreground flex-1 min-w-48">
                {outcome.error.reason}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function Reports({ scope, id }: { scope: DashboardScope; id: string }) {
  const reports = useVerificationReports(scope, id);
  return (
    <Section title={t('verification.reports')}>
      <Text variant="caption-1-regular" className="text-muted-foreground">
        {t('verification.noPersonalData')}
      </Text>
      {reports.isPending ? (
        <PageSkeleton variant="table" accessibilityLabel={t('verification.reports')} />
      ) : reports.isError ? (
        <Text variant="body-2-regular" className="text-destructive">
          {t('verification.reportsFailed', {
            reason: describeError(reports.error, t('error.generic')),
          })}
        </Text>
      ) : reports.data.length === 0 ? (
        <Text variant="body-2-regular" className="text-muted-foreground">
          {t('verification.reportsEmpty')}
        </Text>
      ) : (
        reports.data.map((report) => <ReportRow key={report.id} report={report} />)
      )}
    </Section>
  );
}

function required(value: boolean | null | undefined): string {
  return t(value ? 'verification.required' : 'verification.notRequired');
}

function SessionDetail({
  scope,
  session,
}: {
  scope: DashboardScope;
  session: VerificationSession;
}) {
  const link = hostedLinkOf(session);
  const document = session.options.document;
  return (
    <View className="gap-6">
      <DetailHeader
        headline={labelFor('verificationType', session.type)}
        status={<VerificationStatusBadge status={session.status} />}
        id={session.id}
        facts={[
          {
            label: t('verification.field.reference'),
            value: session.client_reference_id ?? '—',
          },
          { label: t('list.column.created'), value: <Timestamp seconds={session.created} /> },
        ]}
      />
      {link ? <HostedLink url={link} /> : null}
      {session.last_error && session.status === 'requires_input' ? (
        <Admonition type="warning">
          <View className="gap-1">
            <Text variant="body-2-semibold">{t('verification.lastError')}</Text>
            <AdmonitionText>{session.last_error.reason}</AdmonitionText>
            <AdmonitionText>{t('verification.lastErrorHint')}</AdmonitionText>
          </View>
        </Admonition>
      ) : null}
      {session.redaction ? (
        <Admonition type="info">
          <AdmonitionText>{t('verification.redactedNote')}</AdmonitionText>
        </Admonition>
      ) : null}
      <Actions scope={scope} session={session} />
      <DetailLayout
        aside={
          <Section title={t('verification.details')}>
            <Field label={t('verification.field.id')} value={session.id} mono />
            <Field
              label={t('verification.field.type')}
              value={labelFor('verificationType', session.type)}
            />
            {document ? (
              <>
                <Field
                  label={t('verification.field.allowedTypes')}
                  value={
                    document.allowed_types?.length
                      ? document.allowed_types
                          .map((type) => labelFor('documentType', type))
                          .join(', ')
                      : t('verification.field.allowedTypesAll')
                  }
                />
                <Field
                  label={t('verification.field.liveCapture')}
                  value={required(document.require_live_capture)}
                />
                <Field
                  label={t('verification.field.selfie')}
                  value={required(document.require_matching_selfie)}
                />
                <Field
                  label={t('verification.field.idNumber')}
                  value={required(document.require_id_number)}
                />
              </>
            ) : null}
            {session.return_url ? (
              <Field label={t('verification.field.returnUrl')} value={session.return_url} mono />
            ) : null}
            {session.redaction ? (
              <Field
                label={t('verification.field.redaction')}
                value={labelFor('redactionStatus', session.redaction.status)}
              />
            ) : null}
          </Section>
        }
      >
        <Reports scope={scope} id={session.id} />
      </DetailLayout>
    </View>
  );
}

function SessionLoader({ scope, id }: { scope: DashboardScope; id: string }) {
  const query = useVerificationSession(scope, id);
  if (query.isPending)
    return <PageSkeleton variant="detail" accessibilityLabel={t('verification.title')} />;
  if (query.isError) {
    // A 404 for this object: it does not exist in this mode.
    if (isNotFound(query.error)) return <NotFound title={t('verification.notFound')} />;
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <SessionDetail scope={scope} session={query.data} />;
}

export default function VerificationSessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <OrbitScreen title={t('verification.title')}>
      {({ scope }) => (id ? <SessionLoader scope={scope} id={id} /> : null)}
    </OrbitScreen>
  );
}
