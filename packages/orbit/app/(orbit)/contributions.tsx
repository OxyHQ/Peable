import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContributionSchema,
  decimalContributionAmount,
  formatContributionAmount,
  type ContributionCollectionList,
  type ContributionLink,
  type CreateContribution,
} from '@peable.to/contracts/contributions';
import type { ContributionScope } from '@/api/contributions';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { contributionsApi } from '@/api/client';
import { describeError } from '@/api/transport';
import { utcDay } from '@/format/time';
import { t } from '@/i18n';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { FormField } from '@/ui/FormField';
import { OrbitScreen, Section } from '@/ui/OrbitScreen';
import { PermissionNotice, PageSkeleton } from '@/ui/states';

type Pending = { key: string; body: CreateContribution };
const NO_COLLECTIONS: ContributionCollectionList = {
  object: 'list',
  data: [],
  has_more: false,
  url: '',
};

/** A stored operation is replayed only when its body is still a valid request. */
function storedPending(stored: string): Pending | null {
  try {
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== 'object' || !('key' in value) || !('body' in value)) return null;
    const body = createContributionSchema.safeParse(value.body);
    return typeof value.key === 'string' && body.success
      ? { key: value.key, body: body.data }
      : null;
  } catch {
    return null;
  }
}

const message = (error: unknown) => describeError(error, t('contributions.error'));

/**
 * One-time contribution links for an organization's application, ported from
 * the wallet's `app/contributions.tsx` onto the same SDK resource and routes.
 *
 * A creation is idempotent across reloads: its key and body are stored BEFORE
 * the request, so a crash or a lost answer is retried with the same key and
 * can never create the link twice; the stored body stays fixed until the result
 * is known.
 */
function ContributionsWorkspace({ scope }: { scope: ContributionScope }) {
  const [purpose, setPurpose] = useState('');
  const [amount, setAmount] = useState('5.00');
  const [amountMode, setAmountMode] = useState<'fixed' | 'free'>('fixed');
  const [expiry, setExpiry] = useState('');
  const [links, setLinks] = useState<ContributionLink[]>([]);
  const [moreLinks, setMoreLinks] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [collections, setCollections] = useState<ContributionCollectionList>(NO_COLLECTIONS);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const configurable = useDashboardPermissions().can('configure');
  const scopeKey = `orbit:contribution-create:${scope.organizationId}:${scope.applicationId}:${scope.environment}`;

  useEffect(() => {
    const current = ++generation.current;
    Promise.all([contributionsApi.list(scope), AsyncStorage.getItem(scopeKey)])
      .then(([page, stored]) => {
        if (current !== generation.current) return;
        setLoaded(true);
        setLinks(page.data);
        setMoreLinks(page.has_more);
        const operation = stored ? storedPending(stored) : null;
        if (operation) {
          setPending(operation);
          setPurpose(operation.body.purpose);
          setAmountMode(operation.body.amount_mode);
          setAmount(formatContributionAmount(operation.body.amount ?? '500000000'));
          setExpiry(operation.body.expires_at ? utcDay(operation.body.expires_at) : '');
        } else if (stored) void AsyncStorage.removeItem(scopeKey);
      })
      .catch((e) => {
        if (current === generation.current) {
          setLoaded(true);
          setError(message(e));
        }
      });
  }, [scope, scopeKey]);

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
          amount_mode: amountMode,
          currency: 'FAIR' as const,
          ...(amountMode === 'fixed' ? { amount: decimalContributionAmount(amount) } : {}),
          expires_at: expiry ? Math.floor(Date.parse(`${expiry}T23:59:59Z`) / 1000) : null,
        },
      };
      await AsyncStorage.setItem(scopeKey, JSON.stringify(operation));
      setPending(operation);
      const link = await contributionsApi.create(scope, operation.body, operation.key);
      setLinks((rows) => [link, ...rows.filter((row) => row.id !== link.id)]);
      await AsyncStorage.removeItem(scopeKey);
      setPending(null);
      setPurpose('');
    });
  }

  if (!loaded)
    return <PageSkeleton variant="form" accessibilityLabel={t('contributions.heading')} />;

  return (
    <View className="gap-6">
      {error ? (
        <Admonition type="error">
          <AdmonitionText>{error}</AdmonitionText>
        </Admonition>
      ) : null}
      {configurable ? (
        <Section
          title={t('contributions.create')}
          description={
            scope.environment === 'production'
              ? t('contributions.productionHelp')
              : t('contributions.testHelp')
          }
        >
          <FormField
            label={t('contributions.purpose')}
            value={purpose}
            onChange={setPurpose}
            autoCapitalize="sentences"
            disabled={!!pending || busy}
          />
          <View className="gap-1.5">
            <Text variant="caption-1-medium" className="text-muted-foreground">
              {t('contributions.amountMode')}
            </Text>
            <SegmentedControl<'fixed' | 'free'>
              label={t('contributions.amountMode')}
              type="radio"
              size="sm"
              value={amountMode}
              disabled={!!pending || busy}
              onValueChange={setAmountMode}
            >
              <SegmentedControlItem value="fixed">
                <SegmentedControlItemText>{t('contributions.fixed')}</SegmentedControlItemText>
              </SegmentedControlItem>
              <SegmentedControlItem value="free">
                <SegmentedControlItemText>{t('contributions.free')}</SegmentedControlItemText>
              </SegmentedControlItem>
            </SegmentedControl>
          </View>
          {amountMode === 'fixed' ? (
            <FormField
              label={t('contributions.amount')}
              value={amount}
              onChange={setAmount}
              keyboardType="decimal-pad"
              disabled={!!pending || busy}
            />
          ) : null}
          <FormField
            label={t('contributions.expiry')}
            value={expiry}
            onChange={setExpiry}
            placeholder="2026-12-31"
            disabled={!!pending || busy}
          />
          {pending ? (
            <Text variant="body-2-regular" className="text-muted-foreground">
              {t('contributions.retryHelp')}
            </Text>
          ) : null}
          <View className="flex-row justify-end">
            <Button
              appearance="solid"
              tone="accent"
              loading={busy}
              disabled={!purpose.trim()}
              onPress={() => void create()}
            >
              {pending ? t('contributions.retry') : t('contributions.create')}
            </Button>
          </View>
        </Section>
      ) : (
        <PermissionNotice action="configure" />
      )}

      <Section title={t('contributions.links')}>
        {!links.length ? (
          <Text variant="body-2-regular" className="text-muted-foreground">
            {t('contributions.noLinks')}
          </Text>
        ) : null}
        {links.map((link) => (
          <View key={link.id} className="gap-2 py-3 border-b border-border">
            <View className="flex-row flex-wrap items-center gap-2">
              <Text variant="body-2-semibold">{link.contribution.purpose}</Text>
              <Badge
                appearance="subtle"
                tone={link.active ? 'success' : 'neutral'}
                size="label-small"
                content={link.active ? t('contributions.active') : t('contributions.disabled')}
              />
            </View>
            <Text variant="caption-1-regular" className="text-muted-foreground">
              {link.contribution.amount_mode === 'free'
                ? t('contributions.freeAmount')
                : `${formatContributionAmount(link.amount)} ${link.currency}`}{' '}
              · {link.network}
              {link.contribution.expires_at
                ? ` · ${t('contributions.ends', { date: utcDay(link.contribution.expires_at) })}`
                : ''}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              <Button
                appearance="outline"
                size="sm"
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    await Clipboard.setStringAsync(link.url);
                    toast.success(t('contributions.copied'));
                  })
                }
              >
                {t('contributions.copy')}
              </Button>
              <Button
                appearance="outline"
                size="sm"
                disabled={busy || !configurable}
                onPress={() =>
                  void run(async () => {
                    const updated = await contributionsApi.setActive(scope, link.id, !link.active);
                    setLinks((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
                  })
                }
              >
                {link.active ? t('contributions.disable') : t('contributions.enable')}
              </Button>
              <Button
                appearance="plain"
                size="sm"
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    setCollections(await contributionsApi.collections(scope, link.id));
                    setSelected(link.id);
                  })
                }
              >
                {t('contributions.view')}
              </Button>
            </View>
          </View>
        ))}
        {moreLinks ? (
          <View className="items-center pt-2">
            <Button
              appearance="outline"
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  const page = await contributionsApi.list(scope, {
                    starting_after: links[links.length - 1]?.id,
                  });
                  setLinks((rows) => [...rows, ...page.data]);
                  setMoreLinks(page.has_more);
                })
              }
            >
              {t('contributions.moreLinks')}
            </Button>
          </View>
        ) : null}
      </Section>

      {selected ? (
        <Section title={t('contributions.payments')} description={t('contributions.refundHelp')}>
          {!collections.data.length ? (
            <Text variant="body-2-regular" className="text-muted-foreground">
              {t('contributions.empty')}
            </Text>
          ) : null}
          {collections.data.map((payment) => (
            <View key={payment.id} className="py-3 border-b border-border gap-0.5">
              <Text variant="body-2-regular" selectable>
                {payment.id} · {formatContributionAmount(payment.amount)} {payment.currency} ·{' '}
                {payment.status}
              </Text>
              {payment.refunds.map((refund) => (
                <Text key={refund.id} variant="caption-1-regular" className="text-muted-foreground">
                  {t('contributions.refund', {
                    amount: `${formatContributionAmount(refund.amount)} ${payment.currency}`,
                    status: refund.status,
                  })}
                </Text>
              ))}
            </View>
          ))}
          {collections.has_more ? (
            <View className="items-center pt-2">
              <Button
                appearance="outline"
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    const page = await contributionsApi.collections(scope, selected, {
                      starting_after: collections.data[collections.data.length - 1]?.id,
                    });
                    setCollections((prior) => ({ ...page, data: [...prior.data, ...page.data] }));
                  })
                }
              >
                {t('contributions.morePayments')}
              </Button>
            </View>
          ) : null}
        </Section>
      ) : null}
    </View>
  );
}

export default function ContributionsScreen() {
  return (
    <OrbitScreen
      title={t('contributions.heading')}
      description={t('contributions.intro')}
      merchant="optional"
    >
      {({ contributionScope }) =>
        contributionScope ? (
          <ContributionsWorkspace
            key={`${contributionScope.organizationId}:${contributionScope.applicationId}:${contributionScope.environment}`}
            scope={contributionScope}
          />
        ) : null
      }
    </OrbitScreen>
  );
}
