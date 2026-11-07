import { useState } from 'react';
import { View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateTerminalLocationParams, TerminalLocation } from '@peable.to/shared-types';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { isOrbitApiError } from '@/api/transport';
import { t } from '@/i18n';
import { FormField } from '@/ui/FormField';
import {
  buildLocationBody,
  EMPTY_LOCATION_FORM,
  type LocationForm,
  type LocationFormError,
  locationFormOf,
} from './terminalForm';
import { terminalErrorMessage } from './TerminalParts';
import { terminalKeys } from './useTerminal';

interface PendingSave {
  /** Only a create carries a key: a retry after an unknown outcome adds one location, not two. */
  readonly key: string | null;
  readonly body: CreateTerminalLocationParams;
}

/**
 * "Add location" (no `location`) or "Edit" (the location): a name and an
 * address with its country. A create is sent under one idempotency key per
 * attempt, kept while the outcome is unknown; an edit sends the whole address.
 */
export function LocationEditor({
  scope,
  location,
  onDone,
  onClose,
}: {
  scope: DashboardScope;
  location?: TerminalLocation;
  onDone: (location: TerminalLocation) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<LocationForm>(
    location ? locationFormOf(location) : EMPTY_LOCATION_FORM,
  );
  const [invalid, setInvalid] = useState<LocationFormError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSave | null>(null);

  const save = useMutation({
    mutationFn: (request: PendingSave) =>
      location
        ? dashboardApi.terminal.locations.update(scope, location.id, request.body)
        : dashboardApi.terminal.locations.create(scope, request.body, request.key ?? undefined),
    onSuccess: (saved) => {
      setPending(null);
      setError(null);
      toast.success(t(location ? 'terminal.location.saved' : 'terminal.location.created'));
      void queryClient.invalidateQueries({ queryKey: terminalKeys.all(scope) });
      onDone(saved);
    },
    onError: (failure) => {
      setError(t('terminal.location.failed', { reason: terminalErrorMessage(failure) }));
      // An answer means the gateway decided; only an unknown outcome keeps the key.
      if (isOrbitApiError(failure) && failure.status > 0 && failure.status < 500) setPending(null);
    },
  });

  const submit = () => {
    if (pending) {
      save.mutate(pending);
      return;
    }
    const result = buildLocationBody(form);
    setInvalid(result.ok ? null : result.error);
    if (!result.ok) return;
    const request: PendingSave = {
      key: location ? null : Crypto.randomUUID(),
      body: result.body,
    };
    if (!location) setPending(request);
    save.mutate(request);
  };

  const locked = pending !== null || save.isPending;
  const update = (patch: Partial<LocationForm>) => setForm((prior) => ({ ...prior, ...patch }));
  const hint = (field: LocationFormError) =>
    invalid === field ? t(`terminal.location.error.${field}`) : undefined;
  const lineHint = hint('line');
  const field = (
    key: 'line1' | 'line2' | 'city' | 'state',
    label: string,
    invalidHint: string | undefined,
  ) => (
    <View className="flex-1 min-w-56">
      <FormField
        label={label}
        value={form[key]}
        onChange={(value) => update({ [key]: value })}
        autoCapitalize="words"
        invalid={invalidHint !== undefined}
        hint={invalidHint}
        disabled={locked}
      />
    </View>
  );

  return (
    <View className="gap-4 rounded-lg border border-border p-4">
      <Text variant="body-medium">
        {location
          ? t('terminal.location.formTitleEdit', { name: location.display_name })
          : t('terminal.location.formTitleNew')}
      </Text>
      {error ? (
        <Admonition type="error">
          <AdmonitionText>{error}</AdmonitionText>
        </Admonition>
      ) : null}
      <FormField
        label={t('terminal.location.displayName')}
        value={form.displayName}
        onChange={(displayName) => update({ displayName })}
        autoCapitalize="words"
        invalid={hint('displayName') !== undefined}
        hint={hint('displayName') ?? t('terminal.location.displayNameHint')}
        disabled={locked}
      />
      <View className="flex-row flex-wrap gap-4">
        {field('line1', t('terminal.location.line1'), lineHint)}
        {field('line2', t('terminal.location.line2'), undefined)}
      </View>
      <View className="flex-row flex-wrap gap-4">
        {field('city', t('terminal.location.city'), undefined)}
        {field('state', t('terminal.location.state'), undefined)}
      </View>
      <View className="flex-row flex-wrap gap-4">
        <View className="flex-1 min-w-56">
          <FormField
            label={t('terminal.location.postalCode')}
            value={form.postalCode}
            onChange={(postalCode) => update({ postalCode })}
            autoCapitalize="characters"
            invalid={hint('postalCode') !== undefined}
            hint={hint('postalCode')}
            disabled={locked}
          />
        </View>
        <View className="flex-1 min-w-56">
          <FormField
            label={t('terminal.location.country')}
            value={form.country}
            onChange={(country) => update({ country })}
            placeholder="US"
            autoCapitalize="characters"
            invalid={hint('country') !== undefined}
            hint={hint('country') ?? t('terminal.location.countryHint')}
            disabled={locked}
          />
        </View>
      </View>
      <Text variant="caption-1-regular" className="text-muted-foreground">
        {t('terminal.location.addressHint')}
      </Text>
      <View className="flex-row flex-wrap justify-end gap-2">
        <Button appearance="outline" tone="accent" disabled={save.isPending} onPress={onClose}>
          {t('collect.close')}
        </Button>
        <Button appearance="solid" tone="accent" loading={save.isPending} onPress={submit}>
          {pending && !save.isPending
            ? t('terminal.location.retry')
            : t(location ? 'terminal.location.save' : 'terminal.location.create')}
        </Button>
      </View>
    </View>
  );
}
