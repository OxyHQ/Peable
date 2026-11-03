import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConnectedAccount } from '@peable.to/shared-types';
import { Button, LinkButton } from '@oxy.so/bloom/button';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
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
import {
  type CreateConnectedAccountBody,
  type DashboardScope,
  isMerchantMissing,
} from '@/api/dashboard';
import { describeError } from '@/api/transport';
import {
  buildSellerBody,
  EMPTY_SELLER_FORM,
  type SellerForm,
  type SellerFormError,
  sellerPath,
  sellerReadiness,
} from '@/connect/forms';
import { Transfers } from '@/connect/Transfers';
import { connectKeys, useSellerPages } from '@/connect/useConnect';
import { railLabel, readinessLabel, readinessTone } from '@/connect/vocabulary';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { FormField } from '@/ui/FormField';
import { ErrorNotice, MerchantMissing, OrbitScreen, Section } from '@/ui/OrbitScreen';
import { LoadMore } from '@/ui/paging';
import { ToneBadge } from '@/ui/StatusBadge';

const SELLER_ERRORS: Record<SellerFormError, string> = {
  externalRef: 'connect.add.invalid.externalRef',
  rail: 'connect.add.invalid.rail',
  country: 'connect.add.invalid.country',
  oxyUserId: 'connect.add.invalid.oxyUserId',
};

function AddSeller({ scope }: { scope: DashboardScope }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [form, setForm] = useState<SellerForm>(EMPTY_SELLER_FORM);
  const [invalid, setInvalid] = useState<SellerFormError | null>(null);
  // One key per seller being opened, kept across retries of the same form.
  const [key, setKey] = useState(() => Crypto.randomUUID());
  const set =
    <K extends keyof SellerForm>(field: K) =>
    (value: SellerForm[K]) =>
      setForm((prior) => ({ ...prior, [field]: value }));
  const create = useMutation({
    mutationFn: (body: CreateConnectedAccountBody) =>
      dashboardApi.connectedAccounts.create(scope, body, key),
    onSuccess: (account) => {
      toast.success(t('connect.add.done', { ref: account.external_ref }));
      setForm(EMPTY_SELLER_FORM);
      setKey(Crypto.randomUUID());
      void queryClient.invalidateQueries({ queryKey: connectKeys.sellers(scope) });
      router.push(sellerPath(account.id));
    },
    onError: (error) => toast.error(describeError(error, t('error.generic'))),
  });
  const submit = () => {
    const result = buildSellerBody(form);
    setInvalid(result.ok ? null : result.error);
    if (result.ok) create.mutate(result.body);
  };
  const busy = create.isPending;
  const hint = (field: SellerFormError, help: string) =>
    invalid === field ? t(SELLER_ERRORS[field]) : t(help);

  return (
    <View className="gap-4 pb-2">
      <FormField
        label={t('connect.add.externalRef')}
        value={form.externalRef}
        onChange={set('externalRef')}
        hint={hint('externalRef', 'connect.add.externalRefHelp')}
        invalid={invalid === 'externalRef'}
        placeholder="store-42"
        disabled={busy}
      />
      <View className="gap-2">
        <Checkbox
          checked={form.card}
          onCheckedChange={(checked) => set('card')(checked === true)}
          label={t('connect.add.card')}
          disabled={busy}
        />
        {form.card ? (
          <View className="gap-4 pl-6">
            <FormField
              label={t('connect.add.country')}
              value={form.country}
              onChange={set('country')}
              hint={hint('country', 'connect.add.countryHelp')}
              invalid={invalid === 'country'}
              autoCapitalize="characters"
              placeholder="ES"
              disabled={busy}
            />
            <SegmentedControl<SellerForm['businessType']>
              label={t('connect.add.businessType')}
              type="radio"
              size="sm"
              value={form.businessType}
              disabled={busy}
              onValueChange={set('businessType')}
            >
              <SegmentedControlItem value="company">
                <SegmentedControlItemText>{t('account.create.company')}</SegmentedControlItemText>
              </SegmentedControlItem>
              <SegmentedControlItem value="individual">
                <SegmentedControlItemText>
                  {t('account.create.individual')}
                </SegmentedControlItemText>
              </SegmentedControlItem>
            </SegmentedControl>
          </View>
        ) : null}
        <Checkbox
          checked={form.faircoin}
          onCheckedChange={(checked) => set('faircoin')(checked === true)}
          label={t('connect.add.faircoin')}
          disabled={busy}
        />
        {form.faircoin ? (
          <View className="gap-4 pl-6">
            <FormField
              label={t('connect.add.oxyUserId')}
              value={form.oxyUserId}
              onChange={set('oxyUserId')}
              hint={hint('oxyUserId', 'connect.add.oxyUserIdHelp')}
              invalid={invalid === 'oxyUserId'}
              disabled={busy}
            />
            <SegmentedControl<SellerForm['network']>
              label={t('settings.network')}
              type="radio"
              size="sm"
              value={form.network}
              disabled={busy}
              onValueChange={set('network')}
            >
              <SegmentedControlItem value="testnet">
                <SegmentedControlItemText>testnet</SegmentedControlItemText>
              </SegmentedControlItem>
              <SegmentedControlItem value="mainnet">
                <SegmentedControlItemText>mainnet</SegmentedControlItemText>
              </SegmentedControlItem>
            </SegmentedControl>
          </View>
        ) : null}
        {invalid === 'rail' ? (
          <Text variant="caption-1-regular" className="text-destructive">
            {t(SELLER_ERRORS.rail)}
          </Text>
        ) : null}
      </View>
      <View className="flex-row justify-end">
        <Button appearance="solid" tone="accent" loading={busy} onPress={submit}>
          {t('connect.add.submit')}
        </Button>
      </View>
    </View>
  );
}

const COLUMNS = {
  seller: { flex: 3, minWidth: 200 },
  status: { flex: 2, minWidth: 130 },
  rails: { flex: 2, minWidth: 130 },
  id: { flex: 3, minWidth: 200 },
  created: { flex: 2, minWidth: 160 },
} as const;

function SellersTable({ sellers }: { sellers: readonly ConnectedAccount[] }) {
  const router = useRouter();
  return (
    <Table accessibilityLabel={t('connect.sellers')} minWidth={820}>
      <TableHeader>
        <TableColumn {...COLUMNS.seller}>{t('connect.column.seller')}</TableColumn>
        <TableColumn {...COLUMNS.status}>{t('connect.column.status')}</TableColumn>
        <TableColumn {...COLUMNS.rails}>{t('connect.column.rails')}</TableColumn>
        <TableColumn {...COLUMNS.id}>{t('connect.column.id')}</TableColumn>
        <TableColumn {...COLUMNS.created}>{t('connect.column.created')}</TableColumn>
      </TableHeader>
      <TableBody>
        {sellers.map((seller) => {
          const readiness = sellerReadiness(seller);
          return (
            <TableRow key={seller.id}>
              <TableCell {...COLUMNS.seller}>{seller.external_ref}</TableCell>
              <TableCell {...COLUMNS.status}>
                <ToneBadge tone={readinessTone(readiness)} label={readinessLabel(readiness)} />
              </TableCell>
              <TableCell {...COLUMNS.rails}>{seller.rails.map(railLabel).join(', ')}</TableCell>
              <TableCell {...COLUMNS.id}>
                <LinkButton
                  size="sm"
                  accessibilityLabel={`${t('connect.seller')} ${seller.id}`}
                  onPress={() => router.push(sellerPath(seller.id))}
                >
                  {seller.id}
                </LinkButton>
              </TableCell>
              <TableCell {...COLUMNS.created}>{formatInstant(seller.created)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function Sellers({ scope }: { scope: DashboardScope }) {
  const pages = useSellerPages(scope);
  if (pages.isPending) return <Loading accessibilityLabel={t('connect.sellers')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <MerchantMissing environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const sellers = pages.data.pages.flatMap((page) => page.data);
  return (
    <Section title={t('connect.sellers')} description={t('connect.sellersIntro')}>
      <AddSeller scope={scope} />
      {sellers.length ? (
        <SellersTable sellers={sellers} />
      ) : (
        <EmptyState
          variant="compact"
          title={t('connect.sellers.empty.title')}
          description={t('connect.sellers.empty.body')}
        />
      )}
      <LoadMore pages={pages} />
    </Section>
  );
}

export default function ConnectScreen() {
  return (
    <OrbitScreen title={t('connect.title')} description={t('connect.description')}>
      {({ scope }) => (
        <View key={`${scope.applicationId}:${scope.environment}`} className="gap-6">
          <Sellers scope={scope} />
          <Transfers scope={scope} seller={null} />
        </View>
      )}
    </OrbitScreen>
  );
}
