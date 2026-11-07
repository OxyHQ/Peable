import { useState } from 'react';
import { View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CreateVerificationSessionParams,
  VerificationDocumentType,
  VerificationSession,
  VerificationSessionType,
} from '@peable.to/shared-types';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { isOrbitApiError } from '@/api/transport';
import { labelFor, t } from '@/i18n';
import { FormField } from '@/ui/FormField';
import { Toggle } from '@/ui/Toggle';
import {
  buildVerificationBody,
  EMPTY_VERIFICATION_FORM,
  ORBIT_DOCUMENT_TYPES,
  ORBIT_VERIFICATION_TYPES,
  type VerificationForm,
  type VerificationFormError,
} from './identityForm';
import { identityErrorMessage } from './IdentityParts';
import { identityKeys } from './useIdentity';

interface PendingCreate {
  readonly key: string;
  readonly body: CreateVerificationSessionParams;
}

/**
 * "Verify someone": the check and its options, then one create — under one
 * idempotency key per attempt, kept while the outcome is unknown so a retry
 * makes one session, not two. The created session (with its one-time link)
 * goes to `onCreated`.
 */
export function CreateVerification({
  scope,
  onCreated,
  onClose,
}: {
  scope: DashboardScope;
  onCreated: (session: VerificationSession) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<VerificationForm>(EMPTY_VERIFICATION_FORM);
  const [invalid, setInvalid] = useState<VerificationFormError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingCreate | null>(null);

  const create = useMutation({
    mutationFn: (request: PendingCreate) =>
      dashboardApi.identity.sessions.create(scope, request.body, request.key),
    onSuccess: (session) => {
      setPending(null);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: identityKeys.all(scope) });
      onCreated(session);
    },
    onError: (failure) => {
      setError(t('identity.form.failed', { reason: identityErrorMessage(failure) }));
      // An answer means the gateway decided; only an unknown outcome keeps the key.
      if (isOrbitApiError(failure) && failure.status > 0 && failure.status < 500) setPending(null);
    },
  });

  const submit = () => {
    if (pending) {
      create.mutate(pending);
      return;
    }
    const result = buildVerificationBody(form);
    setInvalid(result.ok ? null : result.error);
    if (!result.ok) return;
    const request: PendingCreate = { key: Crypto.randomUUID(), body: result.body };
    setPending(request);
    create.mutate(request);
  };

  const locked = pending !== null || create.isPending;
  const update = (patch: Partial<VerificationForm>) => setForm((prior) => ({ ...prior, ...patch }));
  const toggleType = (type: VerificationDocumentType, on: boolean) =>
    update({
      allowedTypes: on
        ? [...form.allowedTypes, type]
        : form.allowedTypes.filter((value) => value !== type),
    });
  const hint = (field: VerificationFormError) =>
    invalid === field ? t(`identity.form.error.${field}`) : undefined;

  return (
    <View className="gap-4 rounded-lg border border-border p-4">
      <Text variant="body-medium">{t('identity.form.title')}</Text>
      {error ? (
        <Admonition type="error">
          <AdmonitionText>{error}</AdmonitionText>
        </Admonition>
      ) : null}
      <View className="gap-1.5">
        <Text variant="caption-1-medium" className="text-muted-foreground">
          {t('identity.form.type')}
        </Text>
        <SegmentedControl<VerificationSessionType>
          label={t('identity.form.type')}
          type="radio"
          size="sm"
          value={form.type}
          disabled={locked}
          onValueChange={(type) => update({ type })}
        >
          {ORBIT_VERIFICATION_TYPES.map((type) => (
            <SegmentedControlItem key={type} value={type}>
              <SegmentedControlItemText>
                {labelFor('verificationType', type)}
              </SegmentedControlItemText>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </View>
      {form.type === 'document' ? (
        <View className="gap-2">
          <View className="gap-1">
            <Text variant="caption-1-medium" className="text-muted-foreground">
              {t('identity.form.allowedTypes')}
            </Text>
            <Text variant="caption-1-regular" className="text-muted-foreground">
              {t('identity.form.allowedTypesHint')}
            </Text>
          </View>
          {ORBIT_DOCUMENT_TYPES.map((type) => (
            <Toggle
              key={type}
              label={labelFor('documentType', type)}
              value={form.allowedTypes.includes(type)}
              onChange={(on) => toggleType(type, on)}
              disabled={locked}
            />
          ))}
          <Toggle
            label={t('identity.form.liveCapture')}
            hint={t('identity.form.liveCaptureHint')}
            value={form.requireLiveCapture}
            onChange={(requireLiveCapture) => update({ requireLiveCapture })}
            disabled={locked}
          />
          <Toggle
            label={t('identity.form.selfie')}
            hint={t('identity.form.selfieHint')}
            value={form.requireMatchingSelfie}
            onChange={(requireMatchingSelfie) => update({ requireMatchingSelfie })}
            disabled={locked}
          />
          <Toggle
            label={t('identity.form.idNumber')}
            hint={t('identity.form.idNumberHint')}
            value={form.requireIdNumber}
            onChange={(requireIdNumber) => update({ requireIdNumber })}
            disabled={locked}
          />
        </View>
      ) : null}
      <View className="flex-row flex-wrap gap-4">
        <View className="flex-1 min-w-56">
          <FormField
            label={t('identity.form.returnUrl')}
            value={form.returnUrl}
            onChange={(returnUrl) => update({ returnUrl })}
            placeholder="https://example.com/verified"
            keyboardType="url"
            invalid={hint('returnUrl') !== undefined}
            hint={hint('returnUrl') ?? t('identity.form.returnUrlHint')}
            disabled={locked}
          />
        </View>
        <View className="flex-1 min-w-56">
          <FormField
            label={t('identity.form.reference')}
            value={form.clientReferenceId}
            onChange={(clientReferenceId) => update({ clientReferenceId })}
            invalid={hint('clientReferenceId') !== undefined}
            hint={hint('clientReferenceId') ?? t('identity.form.referenceHint')}
            disabled={locked}
          />
        </View>
      </View>
      <View className="flex-row flex-wrap justify-end gap-2">
        <Button appearance="outline" tone="accent" disabled={create.isPending} onPress={onClose}>
          {t('identity.form.close')}
        </Button>
        <Button appearance="solid" tone="accent" loading={create.isPending} onPress={submit}>
          {pending && !create.isPending ? t('identity.form.retry') : t('identity.form.create')}
        </Button>
      </View>
    </View>
  );
}
