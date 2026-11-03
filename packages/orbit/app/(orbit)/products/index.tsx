import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Product } from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import { Button, LinkButton } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { PriceFields } from '@/catalog/PriceFields';
import {
  buildCreateProductBody,
  EMPTY_PRICE_FORM,
  EMPTY_PRODUCT_FORM,
  type PriceForm,
  type ProductForm,
  type ProductFormError,
} from '@/catalog/productForm';
import { catalogKeys, type ProductFilter, useProductPages } from '@/catalog/useCatalog';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { Choice } from '@/ui/Choice';
import { FormField } from '@/ui/FormField';
import { ErrorNotice, MerchantMissing, OrbitScreen, Section } from '@/ui/OrbitScreen';

const filterOptions = () => [
  { value: 'active', label: t('products.filter.active') },
  { value: 'archived', label: t('products.filter.archived') },
  { value: 'all', label: t('products.filter.all') },
];

function filterValue(filter: ProductFilter): string {
  return filter === null ? 'all' : filter ? 'active' : 'archived';
}

function ActiveFilter({
  value,
  onChange,
}: {
  value: ProductFilter;
  onChange: (filter: ProductFilter) => void;
}) {
  return (
    <View className="w-56">
      <Choice
        size="sm"
        label={t('products.filter')}
        value={filterValue(value)}
        options={filterOptions()}
        onChange={(next) => onChange(next === 'all' ? null : next === 'active')}
      />
    </View>
  );
}

function AddProduct({ scope }: { scope: DashboardScope }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [form, setForm] = useState<ProductForm>(EMPTY_PRODUCT_FORM);
  const [withPrice, setWithPrice] = useState(true);
  const [price, setPrice] = useState<PriceForm>(EMPTY_PRICE_FORM);
  const [invalid, setInvalid] = useState<ProductFormError | null>(null);
  const set = (field: keyof ProductForm) => (value: string) =>
    setForm((prior) => ({ ...prior, [field]: value }));
  const create = useMutation({
    mutationFn: (body: Parameters<typeof dashboardApi.products.create>[1]) =>
      dashboardApi.products.create(scope, body),
    onSuccess: (product) => {
      toast.success(t('products.added'));
      setForm(EMPTY_PRODUCT_FORM);
      setPrice(EMPTY_PRICE_FORM);
      void queryClient.invalidateQueries({ queryKey: catalogKeys.all(scope) });
      router.push({ pathname: '/products/[id]', params: { id: product.id } });
    },
    onError: (error) => toast.error(describeError(error, t('error.generic'))),
  });
  const submit = () => {
    const result = buildCreateProductBody(form, withPrice ? price : null);
    setInvalid(result.ok ? null : result.error);
    if (result.ok) create.mutate(result.body);
  };
  return (
    <Section title={t('products.new')}>
      <FormField
        label={t('product.field.name')}
        value={form.name}
        onChange={set('name')}
        autoCapitalize="sentences"
        invalid={invalid === 'name'}
        {...(invalid === 'name' ? { hint: t('product.invalidName') } : {})}
        disabled={create.isPending}
      />
      <FormField
        label={t('product.field.description')}
        value={form.description}
        onChange={set('description')}
        autoCapitalize="sentences"
        multiline
        disabled={create.isPending}
      />
      <View className="flex-row">
        <Button appearance="outline" size="sm" onPress={() => setWithPrice((prior) => !prior)}>
          {withPrice ? t('products.withoutPrice') : t('products.withPrice')}
        </Button>
      </View>
      {withPrice ? (
        <PriceFields
          form={price}
          onChange={setPrice}
          invalid={invalid === 'name' ? null : invalid}
          disabled={create.isPending}
        />
      ) : null}
      <View className="flex-row justify-end">
        <Button appearance="solid" tone="accent" loading={create.isPending} onPress={submit}>
          {t('products.add')}
        </Button>
      </View>
    </Section>
  );
}

function ProductRow({ product }: { product: Product }) {
  const router = useRouter();
  return (
    <View className="gap-1 py-3 border-b border-border">
      <View className="flex-row flex-wrap items-center gap-2">
        <Badge
          appearance="subtle"
          tone={product.active ? 'success' : 'neutral'}
          size="label-small"
          content={product.active ? t('products.active') : t('products.archived')}
        />
        <LinkButton
          size="sm"
          accessibilityLabel={`${t('product.title')} ${product.name}`}
          onPress={() => router.push({ pathname: '/products/[id]', params: { id: product.id } })}
        >
          {product.name}
        </LinkButton>
      </View>
      <View className="flex-row flex-wrap gap-x-4 gap-y-1">
        <Text variant="caption-1-regular" selectable className="text-muted-foreground font-mono">
          {product.id}
        </Text>
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {formatInstant(product.created)}
        </Text>
        {product.default_price === null ? (
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {t('products.noPrice')}
          </Text>
        ) : null}
      </View>
      {product.description ? (
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {product.description}
        </Text>
      ) : null}
    </View>
  );
}

function ProductList({ scope, filter }: { scope: DashboardScope; filter: ProductFilter }) {
  const pages = useProductPages(scope, filter);
  if (pages.isPending) return <Loading accessibilityLabel={t('products.title')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <MerchantMissing environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const products = pages.data.pages.flatMap((page) => page.data);
  return (
    <View className="gap-6">
      <AddProduct scope={scope} />
      <Section title={t('products.title')}>
        {products.length ? (
          products.map((product) => <ProductRow key={product.id} product={product} />)
        ) : (
          <EmptyState
            variant="compact"
            title={t('products.empty.title')}
            description={t('products.empty.body')}
          />
        )}
        {pages.hasNextPage ? (
          <View className="items-center pt-2">
            <Button
              appearance="outline"
              loading={pages.isFetchingNextPage}
              onPress={() => void pages.fetchNextPage()}
            >
              {t('action.loadMore')}
            </Button>
          </View>
        ) : null}
      </Section>
    </View>
  );
}

export default function ProductsScreen() {
  const [filter, setFilter] = useState<ProductFilter>(true);
  return (
    <OrbitScreen
      title={t('products.title')}
      description={t('products.description')}
      actions={<ActiveFilter value={filter} onChange={setFilter} />}
    >
      {({ scope }) => <ProductList scope={scope} filter={filter} />}
    </OrbitScreen>
  );
}
