import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  Dispute,
  DisputeFileEvidenceField,
  DisputeTextEvidenceField,
  UpdateDisputeParams,
} from '@peable.to/shared-types';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { AlertDialog } from '@oxy.so/bloom/alert-dialog';
import { Badge } from '@oxy.so/bloom/badge';
import { Button, LinkButton } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import {
  disputeReasonLabel,
  type EvidenceForm,
  evidenceChanges,
  evidenceFieldLabel,
  evidenceLocked,
  formFromDispute,
  formHasEvidence,
  isLongTextField,
  lockedReason,
  ORBIT_DISPUTE_FILE_FIELDS,
  ORBIT_DISPUTE_TEXT_FIELDS,
} from '@/disputes/evidence';
import { disputeKeys, useDispute } from '@/disputes/useDisputes';
import { formatAmount } from '@/format/money';
import { formatInstant, nowSeconds } from '@/format/time';
import { t } from '@/i18n';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { Choice } from '@/ui/Choice';
import { FileUploadField } from '@/ui/FileUploadField';
import { FormField } from '@/ui/FormField';
import {
  DetailHeader,
  DetailLayout,
  ErrorNotice,
  Field,
  OrbitScreen,
  Section,
} from '@/ui/OrbitScreen';
import { ActionPermissionNotice } from '@/ui/ActionPermissionNotice';
import { DisputeStatusBadge } from '@/ui/StatusBadge';
import { isNotFound, NotFound, PageSkeleton } from '@/ui/states';

function idOf(reference: string | { id: string } | null): string | null {
  if (reference === null) return null;
  return typeof reference === 'string' ? reference : reference.id;
}

function DisputeFacts({ dispute }: { dispute: Dispute }) {
  const router = useRouter();
  const details = dispute.evidence_details;
  const intentId = idOf(dispute.payment_intent);
  const chargeId = idOf(dispute.charge);
  const metadata = Object.entries(dispute.metadata ?? {});
  return (
    <Section title={t('dispute.details')}>
      <Field label={t('dispute.field.id')} value={dispute.id} mono />
      <Field
        label={t('dispute.field.amount')}
        value={formatAmount(dispute.amount, dispute.currency)}
      />
      <Field label={t('dispute.field.reason')} value={disputeReasonLabel(dispute.reason)} />
      {intentId ? (
        <Field
          label={t('dispute.field.payment')}
          value={
            <LinkButton
              size="sm"
              accessibilityLabel={`${t('payment.title')} ${intentId}`}
              onPress={() => router.push({ pathname: '/payments/[id]', params: { id: intentId } })}
            >
              {intentId}
            </LinkButton>
          }
        />
      ) : null}
      {chargeId ? <Field label={t('dispute.field.charge')} value={chargeId} mono /> : null}
      <Field
        label={t('dispute.field.refundable')}
        value={dispute.is_charge_refundable ? t('dispute.yes') : t('dispute.no')}
      />
      <Field
        label={t('dispute.field.dueBy')}
        value={
          <View className="flex-row flex-wrap items-center gap-2">
            <Text variant="body-2-regular">{formatInstant(details.due_by)}</Text>
            {details.past_due ? (
              <Badge
                appearance="subtle"
                tone="danger"
                size="label-small"
                content={t('disputes.pastDue')}
              />
            ) : null}
          </View>
        }
      />
      <Field
        label={t('dispute.field.hasEvidence')}
        value={details.has_evidence ? t('dispute.yes') : t('dispute.no')}
      />
      <Field label={t('dispute.field.submitted')} value={formatInstant(details.submitted_at)} />
      <Field
        label={t('payment.field.mode')}
        value={dispute.livemode ? t('scope.live') : t('scope.test')}
      />
      <Field label={t('dispute.field.created')} value={formatInstant(dispute.created)} />
      {metadata.map(([key, value]) => (
        <Field key={key} label={key} value={value} mono />
      ))}
    </Section>
  );
}

/** One file field: what is attached, and a way to detach it. */
function FileFieldRow({
  field,
  value,
  locked,
  onClear,
}: {
  field: DisputeFileEvidenceField;
  value: string;
  locked: boolean;
  onClear: () => void;
}) {
  return (
    <View className="flex-row flex-wrap items-center gap-3 py-2 border-b border-border">
      <Text variant="body-2-medium" className="text-muted-foreground w-56">
        {evidenceFieldLabel(field)}
      </Text>
      <Text
        variant="body-2-regular"
        selectable
        className={value ? 'font-mono flex-1 min-w-40' : 'flex-1 min-w-40 text-muted-foreground'}
      >
        {value || t('dispute.evidence.noFile')}
      </Text>
      {value && !locked ? (
        <Button appearance="plain" size="sm" onPress={onClear}>
          {t('dispute.evidence.removeFile')}
        </Button>
      ) : null}
    </View>
  );
}

type Pending = 'submit' | 'close' | null;

function EvidenceEditor({ scope, dispute }: { scope: DashboardScope; dispute: Dispute }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<EvidenceForm>(() => formFromDispute(dispute));
  const [attachTo, setAttachTo] = useState<DisputeFileEvidenceField>('receipt');
  const [confirming, setConfirming] = useState<Pending>(null);
  const now = nowSeconds();
  // Evidence and acceptance are money (`billing:manage`): without it the form is read-only.
  const permitted = useDashboardPermissions().can('money');
  const locked = !permitted || evidenceLocked(dispute, now);
  const why = lockedReason(dispute, now);

  // A fresh read (after a save or a refetch) is what the form edits next.
  useEffect(() => {
    setForm(formFromDispute(dispute));
  }, [dispute]);

  const changes = useMemo(() => evidenceChanges(dispute, form), [dispute, form]);
  const changed = Object.keys(changes).length > 0;

  const settle = (answer: Dispute) => {
    queryClient.setQueryData(disputeKeys.detail(scope, dispute.id), answer);
    void queryClient.invalidateQueries({ queryKey: [...disputeKeys.all(scope), 'list'] });
  };
  // The gateway's own sentence and request id — never the evidence.
  const fail = (error: unknown) => toast.error(describeError(error, t('error.generic')));

  const save = useMutation({
    mutationFn: (body: UpdateDisputeParams) =>
      dashboardApi.disputes.update(scope, dispute.id, body),
    onSuccess: (answer, body) => {
      settle(answer);
      toast.success(body.submit ? t('dispute.submitted') : t('dispute.saved'));
    },
    onError: fail,
  });
  const close = useMutation({
    mutationFn: () => dashboardApi.disputes.close(scope, dispute.id),
    onSuccess: (answer) => {
      settle(answer);
      toast.success(t('dispute.accepted'));
    },
    onError: fail,
  });
  const busy = save.isPending || close.isPending;

  const setField =
    (field: DisputeTextEvidenceField | DisputeFileEvidenceField) => (value: string) =>
      setForm((prior) => ({ ...prior, [field]: value }));

  const canAccept = dispute.status === 'needs_response' && !locked;

  return (
    <View className="gap-6">
      {why ? (
        <Admonition type="info">
          <AdmonitionText>{why}</AdmonitionText>
        </Admonition>
      ) : !permitted ? (
        <ActionPermissionNotice action="money" />
      ) : (
        <Admonition type="warning">
          <AdmonitionText>{t('dispute.evidence.oneShot')}</AdmonitionText>
        </Admonition>
      )}

      <Section title={t('dispute.evidence.text')} description={t('dispute.evidence.textNote')}>
        <View className="gap-4">
          {ORBIT_DISPUTE_TEXT_FIELDS.map((field) => (
            <FormField
              key={field}
              label={evidenceFieldLabel(field)}
              value={form[field]}
              onChange={setField(field)}
              multiline={isLongTextField(field)}
              autoCapitalize="sentences"
              disabled={locked || busy}
            />
          ))}
        </View>
      </Section>

      <Section title={t('dispute.evidence.files')} description={t('dispute.evidence.filesNote')}>
        {ORBIT_DISPUTE_FILE_FIELDS.map((field) => (
          <FileFieldRow
            key={field}
            field={field}
            value={form[field]}
            locked={locked || busy}
            onClear={() => setField(field)('')}
          />
        ))}
        {locked ? null : (
          <View className="gap-3 pt-2">
            <View className="w-72">
              <Choice
                size="sm"
                label={t('dispute.evidence.attachTo')}
                value={attachTo}
                options={ORBIT_DISPUTE_FILE_FIELDS.map((field) => ({
                  value: field,
                  label: evidenceFieldLabel(field),
                }))}
                onChange={(value) => setAttachTo(value as DisputeFileEvidenceField)}
                disabled={busy}
              />
            </View>
            <FileUploadField
              scope={scope}
              purpose="dispute_evidence"
              label={t('dispute.evidence.upload', { field: evidenceFieldLabel(attachTo) })}
              disabled={busy}
              onUploaded={(file) => {
                setField(attachTo)(file.id);
                toast.success(
                  t('dispute.evidence.attached', { field: evidenceFieldLabel(attachTo) }),
                );
              }}
            />
          </View>
        )}
      </Section>

      {locked ? null : (
        <View className="flex-row flex-wrap justify-end gap-2">
          {canAccept ? (
            <Button
              appearance="outline"
              tone="danger"
              loading={close.isPending}
              disabled={busy}
              onPress={() => setConfirming('close')}
            >
              {t('dispute.accept')}
            </Button>
          ) : null}
          <Button
            appearance="outline"
            loading={save.isPending && confirming === null}
            disabled={busy || !changed}
            onPress={() => save.mutate({ evidence: changes, submit: false })}
          >
            {t('dispute.saveDraft')}
          </Button>
          <Button
            appearance="solid"
            tone="accent"
            disabled={busy}
            onPress={() => {
              if (!formHasEvidence(form)) {
                toast.error(t('dispute.emptyResponse'));
                return;
              }
              setConfirming('submit');
            }}
          >
            {t('dispute.submit')}
          </Button>
        </View>
      )}

      <AlertDialog
        open={confirming === 'submit'}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t('dispute.confirmSubmit.title')}
        description={t('dispute.confirmSubmit.body')}
        confirmLabel={t('dispute.confirmSubmit.action')}
        cancelLabel={t('action.cancel')}
        onConfirm={() => {
          setConfirming(null);
          save.mutate({ ...(changed ? { evidence: changes } : {}), submit: true });
        }}
        onCancel={() => setConfirming(null)}
      />
      <AlertDialog
        open={confirming === 'close'}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t('dispute.confirmAccept.title')}
        description={t('dispute.confirmAccept.body')}
        confirmLabel={t('dispute.confirmAccept.action')}
        cancelLabel={t('action.cancel')}
        destructive
        onConfirm={() => {
          setConfirming(null);
          close.mutate();
        }}
        onCancel={() => setConfirming(null)}
      />
    </View>
  );
}

function DisputeDetail({ scope, dispute }: { scope: DashboardScope; dispute: Dispute }) {
  return (
    <View className="gap-6">
      <DetailHeader
        headline={formatAmount(dispute.amount, dispute.currency)}
        status={<DisputeStatusBadge status={dispute.status} />}
        id={dispute.id}
      />
      <DetailLayout aside={<DisputeFacts dispute={dispute} />}>
        <EvidenceEditor scope={scope} dispute={dispute} />
      </DetailLayout>
    </View>
  );
}

function DisputeLoader({ scope, id }: { scope: DashboardScope; id: string }) {
  const query = useDispute(scope, id);
  if (query.isPending)
    return <PageSkeleton variant="detail" accessibilityLabel={t('dispute.title')} />;
  if (query.isError) {
    // A 404 for this object (a first run is the page gate's): it does not exist in this mode.
    if (isNotFound(query.error)) return <NotFound title={t('dispute.notFound')} />;
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <DisputeDetail scope={scope} dispute={query.data} />;
}

export default function DisputeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <OrbitScreen title={t('dispute.title')}>
      {({ scope }) => (id ? <DisputeLoader scope={scope} id={id} /> : null)}
    </OrbitScreen>
  );
}
