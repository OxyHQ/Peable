import { t } from '@/i18n';
import { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView } from 'react-native';
import { Stack } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AccountNode, Application } from '@oxy.so/core';
import {
  decimalContributionAmount,
  formatContributionAmount,
  type ContributionLink,
  type CreateContribution,
  type ContributionCollectionList,
} from '@peable.to/contracts';
import type { ContributionScope } from '@peable.to/sdk/contributions';
import { oxyServices } from '@/services/oxy-services';
import { contributions } from '@/services/contributions';
import { SafeAreaView } from '@/ui/safe-area-view';

type Collections = ContributionCollectionList;
type Pending = { key: string; body: CreateContribution };
const message = (error: unknown) =>
  error instanceof Error ? error.message : t('contributions.error');
export default function ContributionsScreen() {
  const [organizations, setOrganizations] = useState<AccountNode[]>([]),
    [applications, setApplications] = useState<Application[]>([]);
  const [organizationId, setOrganizationId] = useState(''),
    [applicationId, setApplicationId] = useState(''),
    [environment, setEnvironment] = useState<ContributionScope['environment']>('development');
  const [purpose, setPurpose] = useState(''),
    [amount, setAmount] = useState('5.00'),
    [amountMode, setAmountMode] = useState<'fixed' | 'free'>('fixed');
  const [expiry, setExpiry] = useState(''),
    [links, setLinks] = useState<ContributionLink[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [collections, setCollections] = useState<Collections>({ items: [], nextCursor: null });
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const scope = { organizationId, applicationId, environment };
  const generation = useRef(0);
  const scopeKey = `peable:contribution-create:${organizationId}:${applicationId}:${environment}`;
  useEffect(() => {
    let canceled = false;
    oxyServices.accounts
      .list()
      .then((rows) => {
        if (!canceled)
          setOrganizations(
            rows.filter(
              (row) =>
                row.kind === 'organization' &&
                ['owner', 'admin', 'editor'].includes(row.callerMembership?.role ?? ''),
            ),
          );
      })
      .catch((e) => {
        if (!canceled) setError(message(e));
      });
    return () => {
      canceled = true;
    };
  }, []);
  useEffect(() => {
    let canceled = false;
    setApplicationId('');
    setApplications([]);
    if (organizationId)
      oxyServices.apps
        .list(organizationId)
        .then((rows) => {
          if (!canceled) setApplications(rows.filter((app) => app.status === 'active'));
        })
        .catch((e) => {
          if (!canceled) setError(message(e));
        });
    return () => {
      canceled = true;
    };
  }, [organizationId]);
  useEffect(() => {
    const current = ++generation.current;
    setLinks([]);
    setSelected(null);
    setCollections({ items: [], nextCursor: null });
    setCursor(null);
    setPending(null);
    setLoaded(false);
    setError('');
    if (!organizationId || !applicationId) return;
    Promise.all([
      contributions.list({ organizationId, applicationId, environment }),
      AsyncStorage.getItem(scopeKey),
    ])
      .then(([page, stored]) => {
        if (current !== generation.current) return;
        setLoaded(true);
        setLinks(page.items);
        setCursor(page.nextCursor);
        if (stored) {
          const operation: Pending = JSON.parse(stored);
          setPending(operation);
          setPurpose(operation.body.purpose);
          setAmountMode(operation.body.amountMode);
          setAmount(formatContributionAmount(operation.body.amount ?? '500000000'));
          setExpiry(operation.body.expiresAt?.slice(0, 10) ?? '');
        }
      })
      .catch((e) => {
        if (current === generation.current) setError(message(e));
      });
  }, [organizationId, applicationId, environment, scopeKey]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    await run(async () => {
      const operation = pending ?? {
        key: Crypto.randomUUID(),
        body: {
          purpose,
          amountMode,
          currency: 'FAIR' as const,
          ...(amountMode === 'fixed' ? { amount: decimalContributionAmount(amount) } : {}),
          expiresAt: expiry ? new Date(`${expiry}T23:59:59Z`).toISOString() : null,
        },
      };
      await AsyncStorage.setItem(scopeKey, JSON.stringify(operation));
      setPending(operation);
      const link = await contributions.create(scope, operation.body, operation.key);
      setLinks((rows) => [link, ...rows.filter((row) => row.id !== link.id)]);
      await AsyncStorage.removeItem(scopeKey);
      setPending(null);
      setPurpose('');
    });
  }
  const button = (label: string, action: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={busy || disabled}
      onPress={action}
      className="rounded-xl bg-primary px-4 py-3 my-1"
    >
      <Text className="text-primary-foreground">{label}</Text>
    </Pressable>
  );
  return (
    <SafeAreaView className="flex-1 bg-background">
      <Stack.Screen options={{ title: t('contributions.title') }} />
      <ScrollView contentContainerClassName="p-4 gap-3 max-w-2xl w-full mx-auto pb-20">
        <Text className="text-foreground text-xl font-semibold">{t('contributions.heading')}</Text>
        <Text className="text-muted-foreground">{t('contributions.intro')}</Text>
        {error ? (
          <Text accessibilityRole="alert" className="text-destructive">
            {error}
          </Text>
        ) : null}
        <Text className="text-foreground font-semibold">{t('contributions.organization')}</Text>
        {organizations.map((row) => (
          <View key={row.accountId}>
            {button(
              `${row.accountId === organizationId ? '✓ ' : ''}${row.account.username ?? row.accountId}`,
              () => setOrganizationId(row.accountId),
            )}
          </View>
        ))}
        {!organizations.length ? (
          <Text className="text-muted-foreground">{t('contributions.signin')}</Text>
        ) : null}
        <Text className="text-foreground font-semibold">{t('contributions.application')}</Text>
        {applications.map((app) => (
          <View key={app._id}>
            {button(`${app._id === applicationId ? '✓ ' : ''}${app.name}`, () =>
              setApplicationId(app._id),
            )}
          </View>
        ))}
        <View className="flex-row gap-2">
          {button(
            environment === 'development'
              ? `✓ ${t('contributions.test')}`
              : t('contributions.test'),
            () => setEnvironment('development'),
          )}
          {button(
            environment === 'production' ? `✓ ${t('contributions.live')}` : t('contributions.live'),
            () => setEnvironment('production'),
          )}
        </View>
        {!!applicationId && (
          <>
            <Text className="text-muted-foreground">
              {environment === 'production'
                ? t('contributions.productionHelp')
                : t('contributions.testHelp')}
            </Text>
            <Text className="text-foreground">{t('contributions.purpose')}</Text>
            <TextInput
              accessibilityLabel={t('contributions.purposeLabel')}
              className="border border-border rounded-xl p-3 text-foreground"
              value={purpose}
              onChangeText={setPurpose}
              editable={!pending && !busy}
              maxLength={500}
            />
            <View className="flex-row gap-2">
              {button(
                amountMode === 'fixed' ? `✓ ${t('contributions.fixed')}` : t('contributions.fixed'),
                () => setAmountMode('fixed'),
                !!pending,
              )}
              {button(
                amountMode === 'free' ? `✓ ${t('contributions.free')}` : t('contributions.free'),
                () => setAmountMode('free'),
                !!pending,
              )}
            </View>

            {amountMode === 'fixed' && (
              <TextInput
                accessibilityLabel={t('contributions.amount')}
                className="border border-border rounded-xl p-3 text-foreground"
                keyboardType="decimal-pad"
                value={amount}
                onChangeText={setAmount}
                editable={!pending && !busy}
              />
            )}
            <Text className="text-foreground">{t('contributions.expiry')}</Text>
            <TextInput
              accessibilityLabel={t('contributions.expiryLabel')}
              placeholder="2026-12-31"
              className="border border-border rounded-xl p-3 text-foreground"
              value={expiry}
              onChangeText={setExpiry}
              editable={!pending && !busy}
            />
            {pending && (
              <Text className="text-muted-foreground">{t('contributions.retryHelp')}</Text>
            )}
            {button(
              pending ? t('contributions.retry') : t('contributions.create'),
              () => void create(),
              !purpose.trim() || !loaded,
            )}
            <Text className="text-foreground text-lg font-semibold">
              {t('contributions.links')}
            </Text>
            {links.map((link) => (
              <View key={link.id} className="border border-border rounded-xl p-3 gap-2">
                <Text className="text-foreground">{link.contribution.purpose}</Text>
                <Text className="text-muted-foreground">
                  {link.contribution.amountMode === 'free'
                    ? t('contributions.freeAmount')
                    : `${formatContributionAmount(link.amount)} ${link.currency}`}{' '}
                  · {link.network} ·{' '}
                  {link.active ? t('contributions.active') : t('contributions.disabled')}
                  {link.contribution.expiresAt ? ` · Ends ${link.contribution.expiresAt}` : ''}
                </Text>
                {button(
                  t('contributions.copy'),
                  () =>
                    void run(async () => {
                      await Clipboard.setStringAsync(link.url);
                    }),
                )}
                {button(
                  link.active ? t('contributions.disable') : t('contributions.enable'),
                  () =>
                    void run(async () => {
                      const updated = await contributions.setActive(scope, link.id, !link.active);
                      setLinks((rows) =>
                        rows.map((row) => (row.id === updated.id ? updated : row)),
                      );
                    }),
                )}
                {button(
                  t('contributions.view'),
                  () =>
                    void run(async () => {
                      setCollections(await contributions.collections(scope, link.id));
                      setSelected(link.id);
                    }),
                )}
              </View>
            ))}
            {cursor &&
              button(
                t('contributions.moreLinks'),
                () =>
                  void run(async () => {
                    const page = await contributions.list(scope, { cursor });
                    setLinks((rows) => [...rows, ...page.items]);
                    setCursor(page.nextCursor);
                  }),
              )}
            {selected && (
              <>
                <Text className="text-foreground text-lg font-semibold">
                  {t('contributions.payments')}
                </Text>
                <Text className="text-muted-foreground">{t('contributions.refundHelp')}</Text>
                {!collections.items.length && (
                  <Text className="text-muted-foreground">{t('contributions.empty')}</Text>
                )}
                {collections.items.map((payment) => (
                  <View key={payment.id} className="border border-border rounded-xl p-3">
                    <Text selectable className="text-foreground">
                      {payment.id} · {formatContributionAmount(payment.amount)} {payment.currency} ·{' '}
                      {payment.status}
                    </Text>
                    {payment.refunds.map((refund) => (
                      <Text key={refund.id} className="text-muted-foreground">
                        Refund {formatContributionAmount(refund.amount)} {payment.currency} ·{' '}
                        {refund.status}
                      </Text>
                    ))}
                  </View>
                ))}
                {collections.nextCursor &&
                  button(
                    t('contributions.morePayments'),
                    () =>
                      void run(async () => {
                        const page = await contributions.collections(scope, selected, {
                          cursor: collections.nextCursor ?? undefined,
                        });
                        setCollections((prior) => ({
                          items: [...prior.items, ...page.items],
                          nextCursor: page.nextCursor,
                        }));
                      }),
                  )}
              </>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
