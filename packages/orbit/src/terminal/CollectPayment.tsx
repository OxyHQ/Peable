import { useState } from 'react';
import { View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useMutation } from '@tanstack/react-query';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { CollectOnReaderBody, CollectOnReaderResult, DashboardScope } from '@/api/dashboard';
import { isOrbitApiError } from '@/api/transport';
import { t } from '@/i18n';
import { Choice } from '@/ui/Choice';
import { FormField } from '@/ui/FormField';
import { Toggle } from '@/ui/Toggle';
import {
  buildCollectBody,
  type CollectForm,
  type CollectFormError,
  READER_CURRENCIES,
} from './terminalForm';
import { terminalErrorMessage } from './TerminalParts';

interface PendingCollect {
  readonly key: string;
  readonly body: CollectOnReaderBody;
}

/**
 * "Collect a payment": an amount in a fiat currency, an optional description,
 * and whether to authorize only. One collect under one idempotency key per
 * attempt, kept while the outcome is unknown, so a retry charges the card once.
 */
export function CollectPayment({
  scope,
  readerId,
  defaultCurrency,
  onStarted,
  onClose,
}: {
  scope: DashboardScope;
  readerId: string;
  defaultCurrency: string;
  onStarted: (result: CollectOnReaderResult) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<CollectForm>({
    amount: '',
    currency: defaultCurrency,
    description: '',
    manualCapture: false,
  });
  const [invalid, setInvalid] = useState<CollectFormError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingCollect | null>(null);

  const collect = useMutation({
    mutationFn: (request: PendingCollect) =>
      dashboardApi.terminal.readers.collect(scope, readerId, request.body, request.key),
    onSuccess: (result) => {
      setPending(null);
      setError(null);
      onStarted(result);
    },
    onError: (failure) => {
      setError(t('collect.failed', { reason: terminalErrorMessage(failure) }));
      if (isOrbitApiError(failure) && failure.status > 0 && failure.status < 500) setPending(null);
    },
  });

  const submit = () => {
    if (pending) {
      collect.mutate(pending);
      return;
    }
    const result = buildCollectBody(form);
    setInvalid(result.ok ? null : result.error);
    if (!result.ok) return;
    const request: PendingCollect = { key: Crypto.randomUUID(), body: result.body };
    setPending(request);
    collect.mutate(request);
  };

  const locked = pending !== null || collect.isPending;
  const update = (patch: Partial<CollectForm>) => setForm((prior) => ({ ...prior, ...patch }));
  const hint = (field: CollectFormError) =>
    invalid === field ? t(`collect.error.${field}`) : undefined;

  return (
    <View className="gap-4 rounded-lg border border-border p-4">
      <View className="gap-1">
        <Text variant="body-medium">{t('collect.title')}</Text>
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {t('collect.description')}
        </Text>
      </View>
      {error ? (
        <Admonition type="error">
          <AdmonitionText>{error}</AdmonitionText>
        </Admonition>
      ) : null}
      <View className="flex-row flex-wrap gap-4">
        <View className="flex-1 min-w-56">
          <FormField
            label={t('collect.amount')}
            value={form.amount}
            onChange={(amount) => update({ amount })}
            placeholder="12.50"
            keyboardType="decimal-pad"
            invalid={hint('amount') !== undefined}
            hint={hint('amount') ?? t('collect.amountHint', { currency: form.currency })}
            disabled={locked}
          />
        </View>
        <View className="w-40 gap-1">
          <Choice
            label={t('collect.currency')}
            value={form.currency}
            options={READER_CURRENCIES.map((code) => ({ value: code, label: code }))}
            onChange={(currency) => update({ currency })}
            disabled={locked}
          />
          {hint('currency') ? (
            <Text variant="caption-1-regular" className="text-destructive">
              {hint('currency')}
            </Text>
          ) : null}
        </View>
      </View>
      <FormField
        label={t('collect.descriptionField')}
        value={form.description}
        onChange={(description) => update({ description })}
        autoCapitalize="sentences"
        invalid={hint('description') !== undefined}
        hint={hint('description') ?? t('collect.descriptionHint')}
        disabled={locked}
      />
      <Toggle
        label={t('collect.manual')}
        hint={t('collect.manualHint')}
        value={form.manualCapture}
        onChange={(manualCapture) => update({ manualCapture })}
        disabled={locked}
      />
      <View className="flex-row flex-wrap justify-end gap-2">
        <Button appearance="outline" tone="accent" disabled={collect.isPending} onPress={onClose}>
          {t('collect.close')}
        </Button>
        <Button appearance="solid" tone="accent" loading={collect.isPending} onPress={submit}>
          {pending && !collect.isPending ? t('collect.retry') : t('collect.start')}
        </Button>
      </View>
    </View>
  );
}
