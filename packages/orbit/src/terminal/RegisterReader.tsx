import { useState } from 'react';
import { View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CreateTerminalReaderParams,
  TerminalLocation,
  TerminalReader,
} from '@peable.to/shared-types';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { isOrbitApiError } from '@/api/transport';
import { t } from '@/i18n';
import { Choice } from '@/ui/Choice';
import { FormField } from '@/ui/FormField';
import {
  buildReaderBody,
  EMPTY_READER_FORM,
  isTestMode,
  type ReaderForm,
  type ReaderFormError,
} from './terminalForm';
import { terminalErrorMessage } from './TerminalParts';
import { terminalKeys } from './useTerminal';

interface PendingRegister {
  readonly key: string;
  readonly body: CreateTerminalReaderParams;
}

/**
 * "Register reader": the code the reader shows, the location it is at and an
 * optional label — one register under one idempotency key per attempt, kept
 * while the outcome is unknown so a retry registers the reader once.
 */
export function RegisterReader({
  scope,
  locations,
  onRegistered,
  onClose,
}: {
  scope: DashboardScope;
  locations: readonly TerminalLocation[];
  onRegistered: (reader: TerminalReader) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ReaderForm>({
    ...EMPTY_READER_FORM,
    location: locations.length === 1 ? (locations[0]?.id ?? '') : '',
  });
  const [invalid, setInvalid] = useState<ReaderFormError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRegister | null>(null);
  const test = isTestMode(scope.environment);

  const register = useMutation({
    mutationFn: (request: PendingRegister) =>
      dashboardApi.terminal.readers.register(scope, request.body, request.key),
    onSuccess: (reader) => {
      setPending(null);
      setError(null);
      toast.success(t('terminal.reader.registered'));
      void queryClient.invalidateQueries({ queryKey: terminalKeys.all(scope) });
      onRegistered(reader);
    },
    onError: (failure) => {
      setError(t('terminal.reader.failed', { reason: terminalErrorMessage(failure) }));
      if (isOrbitApiError(failure) && failure.status > 0 && failure.status < 500) setPending(null);
    },
  });

  const submit = () => {
    if (pending) {
      register.mutate(pending);
      return;
    }
    const result = buildReaderBody(form, scope.environment);
    setInvalid(result.ok ? null : result.error);
    if (!result.ok) return;
    const request: PendingRegister = { key: Crypto.randomUUID(), body: result.body };
    setPending(request);
    register.mutate(request);
  };

  const locked = pending !== null || register.isPending;
  const update = (patch: Partial<ReaderForm>) => setForm((prior) => ({ ...prior, ...patch }));
  const hint = (field: ReaderFormError) =>
    invalid === field ? t(`terminal.reader.error.${field}`) : undefined;
  const codeHint = hint('registrationCode') ?? hint('simulatedInLive');

  return (
    <View className="gap-4 rounded-lg border border-border p-4">
      <Text variant="body-medium">{t('terminal.reader.formTitle')}</Text>
      {error ? (
        <Admonition type="error">
          <AdmonitionText>{error}</AdmonitionText>
        </Admonition>
      ) : null}
      {locations.length === 0 ? (
        <Admonition type="info">
          <AdmonitionText>{t('terminal.reader.noLocations')}</AdmonitionText>
        </Admonition>
      ) : null}
      <View className="flex-row flex-wrap gap-4">
        <View className="flex-1 min-w-56">
          <FormField
            label={t('terminal.reader.code')}
            value={form.registrationCode}
            onChange={(registrationCode) => update({ registrationCode })}
            placeholder={test ? 'simulated-wpe' : undefined}
            invalid={codeHint !== undefined}
            hint={codeHint ?? t(test ? 'terminal.reader.codeHintTest' : 'terminal.reader.codeHint')}
            disabled={locked}
          />
        </View>
        <View className="flex-1 min-w-56 gap-1">
          <Choice
            label={t('terminal.reader.location')}
            value={form.location || null}
            placeholder={t('terminal.reader.locationPlaceholder')}
            options={locations.map((location) => ({
              value: location.id,
              label: location.display_name,
            }))}
            onChange={(location) => update({ location })}
            disabled={locked || locations.length === 0}
          />
          {hint('location') ? (
            <Text variant="caption-1-regular" className="text-destructive">
              {hint('location')}
            </Text>
          ) : null}
        </View>
      </View>
      <FormField
        label={t('terminal.reader.label')}
        value={form.label}
        onChange={(label) => update({ label })}
        autoCapitalize="sentences"
        invalid={hint('label') !== undefined}
        hint={hint('label') ?? t('terminal.reader.labelHint')}
        disabled={locked}
      />
      <View className="flex-row flex-wrap justify-end gap-2">
        <Button appearance="outline" tone="accent" disabled={register.isPending} onPress={onClose}>
          {t('collect.close')}
        </Button>
        <Button
          appearance="solid"
          tone="accent"
          loading={register.isPending}
          disabled={locations.length === 0}
          onPress={submit}
        >
          {pending && !register.isPending
            ? t('terminal.reader.retry')
            : t('terminal.reader.register')}
        </Button>
      </View>
    </View>
  );
}
