import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  Price,
  Product,
  UpdatePriceParams,
  UpdateProductParams,
} from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { PriceFields } from '@/catalog/PriceFields';
import {
  buildCreatePriceBody,
  buildUpdateProductBody,
  EMPTY_PRICE_FORM,
  formatPriceLabel,
  type PriceForm,
  type PriceFormError,
  type ProductForm,
  productFormOf,
} from '@/catalog/productForm';
import { catalogKeys, useProduct, useProductPrices } from '@/catalog/useCatalog';
import { billingKeys, useFeatures, useProductFeatures } from '@/billing/useBilling';
import { Choice } from '@/ui/Choice';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { FormField } from '@/ui/FormField';
import { ActionPermissionNotice } from '@/ui/ActionPermissionNotice';
import {
  DetailLayout,
  ErrorNotice,
  Field,
  ListFooter,
  OrbitScreen,
  Section,
} from '@/ui/OrbitScreen';
import { isNotFound, NotFound, PageSkeleton } from '@/ui/states';

/** A reference as its id, whether or not the read expanded it. */
function idOf(reference: string | { id: string } | null): string | null {
  return reference === null || typeof reference === 'string' ? reference : reference.id;
}

function useRefresh(scope: DashboardScope) {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: catalogKeys.all(scope) });
}

const fail = (error: unknown) => toast.error(describeError(error, t('error.generic')));

function EditProduct({ scope, product }: { scope: DashboardScope; product: Product }) {
  const refresh = useRefresh(scope);
  const { can } = useDashboardPermissions();
  const locked = !can('configure');
  const [form, setForm] = useState<ProductForm>(() => productFormOf(product));
  const [invalid, setInvalid] = useState(false);
  const set = (field: keyof ProductForm) => (value: string) =>
    setForm((prior) => ({ ...prior, [field]: value }));
  const save = useMutation({
    mutationFn: (body: UpdateProductParams) =>
      dashboardApi.products.update(scope, product.id, body),
    onSuccess: (updated) => {
      toast.success(t('product.saved'));
      setForm(productFormOf(updated));
      refresh();
    },
    onError: fail,
  });
  const submit = () => {
    const result = buildUpdateProductBody(form, product);
    setInvalid(!result.ok);
    if (!result.ok) return;
    if (Object.keys(result.body).length === 0) {
      toast.success(t('product.nothingChanged'));
      return;
    }
    save.mutate(result.body);
  };
  return (
    <Section title={t('product.details')}>
      <Field label={t('product.field.id')} value={product.id} mono />
      <FormField
        label={t('product.field.name')}
        value={form.name}
        onChange={set('name')}
        autoCapitalize="sentences"
        invalid={invalid}
        {...(invalid ? { hint: t('product.invalidName') } : {})}
        disabled={save.isPending || locked}
      />
      <FormField
        label={t('product.field.description')}
        value={form.description}
        onChange={set('description')}
        autoCapitalize="sentences"
        multiline
        disabled={save.isPending || locked}
      />
      <View className="flex-row flex-wrap gap-4">
        <View className="flex-1 min-w-48">
          <FormField
            label={t('product.field.unitLabel')}
            value={form.unitLabel}
            onChange={set('unitLabel')}
            hint={t('product.field.unitLabelHelp')}
            disabled={save.isPending || locked}
          />
        </View>
        <View className="flex-1 min-w-48">
          <FormField
            label={t('product.field.statementDescriptor')}
            value={form.statementDescriptor}
            onChange={set('statementDescriptor')}
            autoCapitalize="characters"
            hint={t('product.field.statementDescriptorHelp')}
            disabled={save.isPending || locked}
          />
        </View>
      </View>
      <View className="flex-row justify-end">
        <Button
          appearance="solid"
          tone="accent"
          loading={save.isPending}
          disabled={locked}
          onPress={submit}
        >
          {t('product.save')}
        </Button>
      </View>
    </Section>
  );
}

function ProductActions({ scope, product }: { scope: DashboardScope; product: Product }) {
  const refresh = useRefresh(scope);
  const router = useRouter();
  const { can } = useDashboardPermissions();
  const locked = !can('configure');
  const archive = useMutation({
    mutationFn: () => dashboardApi.products.update(scope, product.id, { active: !product.active }),
    onSuccess: (updated) => {
      toast.success(updated.active ? t('product.unarchivedToast') : t('product.archivedToast'));
      refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => dashboardApi.products.delete(scope, product.id),
    onSuccess: () => {
      toast.success(t('product.deleted'));
      refresh();
      router.replace('/products');
    },
    // The gateway refuses a product with prices and says so; show its words.
    onError: fail,
  });
  return (
    <View className="gap-2">
      <View className="flex-row flex-wrap gap-2">
        <Button
          appearance="outline"
          size="sm"
          loading={archive.isPending}
          disabled={locked}
          onPress={() => archive.mutate()}
        >
          {product.active ? t('product.archive') : t('product.unarchive')}
        </Button>
        <Button
          appearance="outline"
          tone="danger"
          size="sm"
          loading={remove.isPending}
          disabled={locked}
          onPress={() => remove.mutate()}
        >
          {t('product.delete')}
        </Button>
      </View>
      <Text variant="caption-1-regular" className="text-muted-foreground">
        {t('product.deleteHelp')}
      </Text>
    </View>
  );
}

function PriceRow({
  scope,
  product,
  price,
}: {
  scope: DashboardScope;
  product: Product;
  price: Price;
}) {
  const refresh = useRefresh(scope);
  const { can } = useDashboardPermissions();
  const locked = !can('configure');
  const isDefault = idOf(product.default_price) === price.id;
  const update = useMutation({
    mutationFn: (body: UpdatePriceParams) => dashboardApi.prices.update(scope, price.id, body),
    onSuccess: () => {
      toast.success(t('product.price.updated'));
      refresh();
    },
    onError: fail,
  });
  const makeDefault = useMutation({
    mutationFn: () => dashboardApi.products.update(scope, product.id, { default_price: price.id }),
    onSuccess: () => {
      toast.success(t('product.saved'));
      refresh();
    },
    onError: fail,
  });
  return (
    <View className="gap-2 py-3 border-b border-border">
      <View className="flex-row flex-wrap items-center gap-2">
        <Badge
          appearance="subtle"
          tone={price.active ? 'success' : 'neutral'}
          size="label-small"
          content={price.active ? t('product.price.active') : t('product.price.archived')}
        />
        {isDefault ? (
          <Badge
            appearance="subtle"
            tone="info"
            size="label-small"
            content={t('product.price.default')}
          />
        ) : null}
        <Text variant="body-2-semibold" selectable>
          {formatPriceLabel(price)}
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-x-4 gap-y-1">
        <Text variant="caption-1-regular" selectable className="text-muted-foreground font-mono">
          {price.id}
        </Text>
        {price.lookup_key ? (
          <Text variant="caption-1-regular" selectable className="text-muted-foreground font-mono">
            {price.lookup_key}
          </Text>
        ) : null}
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {t(`price.tax.${price.tax_behavior}`)}
        </Text>
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {formatInstant(price.created)}
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-2">
        {!isDefault && price.active ? (
          <Button
            appearance="outline"
            size="sm"
            loading={makeDefault.isPending}
            disabled={locked}
            onPress={() => makeDefault.mutate()}
          >
            {t('product.price.makeDefault')}
          </Button>
        ) : null}
        <Button
          appearance="outline"
          size="sm"
          loading={update.isPending}
          disabled={locked}
          onPress={() => update.mutate({ active: !price.active })}
        >
          {price.active ? t('product.price.archive') : t('product.price.unarchive')}
        </Button>
      </View>
    </View>
  );
}

function AddPrice({ scope, product }: { scope: DashboardScope; product: Product }) {
  const refresh = useRefresh(scope);
  const [form, setForm] = useState<PriceForm>(EMPTY_PRICE_FORM);
  const [invalid, setInvalid] = useState<PriceFormError | null>(null);
  const create = useMutation({
    mutationFn: (body: Parameters<typeof dashboardApi.prices.create>[1]) =>
      dashboardApi.prices.create(scope, body),
    onSuccess: () => {
      toast.success(t('product.price.added'));
      setForm(EMPTY_PRICE_FORM);
      refresh();
    },
    onError: fail,
  });
  const submit = () => {
    const result = buildCreatePriceBody(product.id, form);
    setInvalid(result.ok ? null : result.error);
    if (result.ok) create.mutate(result.body);
  };
  return (
    <View className="gap-4 pt-2">
      <PriceFields form={form} onChange={setForm} invalid={invalid} disabled={create.isPending} />
      <View className="flex-row justify-end">
        <Button appearance="solid" tone="accent" loading={create.isPending} onPress={submit}>
          {t('product.price.add')}
        </Button>
      </View>
    </View>
  );
}

function Prices({ scope, product }: { scope: DashboardScope; product: Product }) {
  const pages = useProductPrices(scope, product.id);
  const { can } = useDashboardPermissions();
  let body: React.ReactNode;
  if (pages.isPending)
    body = <PageSkeleton variant="table" rows={3} accessibilityLabel={t('product.prices')} />;
  else if (pages.isError) {
    body = <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  } else {
    const prices = pages.data.pages.flatMap((page) => page.data);
    body = (
      <>
        {prices.length ? (
          prices.map((price) => (
            <PriceRow key={price.id} scope={scope} product={product} price={price} />
          ))
        ) : (
          <EmptyState
            variant="compact"
            title={t('product.prices.empty.title')}
            description={t('product.prices.empty.body')}
          />
        )}
        <ListFooter pages={pages} />
      </>
    );
  }
  return (
    <Section title={t('product.prices')} description={t('product.pricesIntro')}>
      {body}
      {can('configure') ? <AddPrice scope={scope} product={product} /> : null}
    </Section>
  );
}

/** The features this product grants (ADR 0018 §6): what an app checks to grant access. */
function ProductFeatures({ scope, product }: { scope: DashboardScope; product: Product }) {
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const allowed = can('money');
  const attached = useProductFeatures(scope, product.id);
  const features = useFeatures(scope);
  const [choice, setChoice] = useState<string | null>(null);
  const refresh = () =>
    void queryClient.invalidateQueries({
      queryKey: billingKeys.productFeatures(scope, product.id),
    });
  const attach = useMutation({
    mutationFn: (featureId: string) => dashboardApi.features.attach(scope, product.id, featureId),
    onSuccess: () => {
      toast.success(t('product.features.attached'));
      setChoice(null);
      refresh();
    },
    onError: fail,
  });
  const detach = useMutation({
    mutationFn: (attachmentId: string) =>
      dashboardApi.features.detach(scope, product.id, attachmentId),
    onSuccess: () => {
      toast.success(t('product.features.detached'));
      refresh();
    },
    onError: fail,
  });
  if (attached.isPending || features.isPending) {
    return <PageSkeleton variant="table" rows={3} accessibilityLabel={t('product.features')} />;
  }
  if (attached.isError)
    return <ErrorNotice error={attached.error} onRetry={() => void attached.refetch()} />;
  if (features.isError)
    return <ErrorNotice error={features.error} onRetry={() => void features.refetch()} />;
  const granted = new Set(attached.data.data.map((row) => row.entitlement_feature.id));
  const options = features.data.data
    .filter((feature) => feature.active && !granted.has(feature.id))
    .map((feature) => ({ value: feature.id, label: `${feature.name} (${feature.lookup_key})` }));
  return (
    <Section title={t('product.features')} description={t('product.featuresIntro')}>
      <ActionPermissionNotice action="money" />
      {attached.data.data.length ? (
        attached.data.data.map((row) => (
          <View
            key={row.id}
            className="flex-row flex-wrap items-center gap-2 py-2 border-b border-border"
          >
            <Text variant="body-2-semibold">{row.entitlement_feature.name}</Text>
            <Text
              variant="caption-1-regular"
              selectable
              className="text-muted-foreground font-mono"
            >
              {row.entitlement_feature.lookup_key}
            </Text>
            <View className="flex-1" />
            <Button
              appearance="outline"
              size="sm"
              loading={detach.isPending && detach.variables === row.id}
              disabled={!allowed}
              onPress={() => detach.mutate(row.id)}
            >
              {t('product.features.detach')}
            </Button>
          </View>
        ))
      ) : (
        <Text variant="body-2-regular" className="text-muted-foreground">
          {t('product.features.none')}
        </Text>
      )}
      {options.length && allowed ? (
        <View className="flex-row flex-wrap items-end gap-2 pt-2">
          <View className="flex-1 min-w-48">
            <Choice
              label={t('product.features.choose')}
              value={choice}
              options={options}
              onChange={setChoice}
              disabled={attach.isPending}
            />
          </View>
          <Button
            appearance="solid"
            tone="accent"
            size="sm"
            loading={attach.isPending}
            onPress={() => (choice ? attach.mutate(choice) : undefined)}
          >
            {t('product.features.attach')}
          </Button>
        </View>
      ) : null}
    </Section>
  );
}

function ProductDetail({ scope, product }: { scope: DashboardScope; product: Product }) {
  return (
    <View className="gap-6">
      <View className="flex-row flex-wrap items-center gap-3">
        <Text variant="title-1-bold" selectable>
          {product.name}
        </Text>
        <Badge
          appearance="subtle"
          tone={product.active ? 'success' : 'neutral'}
          size="label-small"
          content={product.active ? t('products.active') : t('products.archived')}
        />
      </View>
      <ActionPermissionNotice action="configure" />
      <ProductActions scope={scope} product={product} />
      {/* Keyed by `updated`, so a save elsewhere re-seeds the form from the stored product. */}
      <DetailLayout aside={<EditProduct key={product.updated} scope={scope} product={product} />}>
        <Prices scope={scope} product={product} />
        <ProductFeatures scope={scope} product={product} />
      </DetailLayout>
    </View>
  );
}

function ProductLoader({ scope, id }: { scope: DashboardScope; id: string }) {
  const query = useProduct(scope, id);
  if (query.isPending)
    return <PageSkeleton variant="detail" accessibilityLabel={t('product.title')} />;
  if (query.isError) {
    // A 404 for this object (a first run is the page gate's): it does not exist in this mode.
    if (isNotFound(query.error)) return <NotFound title={t('product.notFound')} />;
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <ProductDetail scope={scope} product={query.data} />;
}

export default function ProductScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <OrbitScreen title={t('product.title')}>
      {({ scope }) => (id ? <ProductLoader scope={scope} id={id} /> : null)}
    </OrbitScreen>
  );
}
