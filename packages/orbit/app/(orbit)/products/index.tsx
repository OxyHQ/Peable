import { type ReactNode, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Product } from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@oxy.so/bloom/table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
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
import { t } from '@/i18n';
import { Choice } from '@/ui/Choice';
import { FormField } from '@/ui/FormField';
import { ErrorNotice, ListFooter, OrbitScreen, Section } from '@/ui/OrbitScreen';
import { RowLink, Timestamp } from '@/ui/data';
import { ListEmpty, PageSkeleton } from '@/ui/states';

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

const COLUMNS = {
  name: { flex: 4, minWidth: 220 },
  pricing: { flex: 2, minWidth: 140 },
  status: { flex: 1, minWidth: 100 },
  created: { flex: 2, minWidth: 140 },
  updated: { flex: 2, minWidth: 140 },
} as const;

/** The catalog, Stripe's table: name and description, pricing, status, dates; a row opens the product. */
function ProductsTable({ products, empty }: { products: Product[]; empty: ReactNode }) {
  const router = useRouter();
  return (
    <Table accessibilityLabel={t('products.title')} minWidth={760} size="sm">
      <TableHeader>
        <TableColumn {...COLUMNS.name}>{t('list.column.name')}</TableColumn>
        <TableColumn {...COLUMNS.pricing}>{t('products.column.pricing')}</TableColumn>
        <TableColumn {...COLUMNS.status}>{t('list.column.status')}</TableColumn>
        <TableColumn {...COLUMNS.created}>{t('list.column.created')}</TableColumn>
        <TableColumn {...COLUMNS.updated}>{t('products.column.updated')}</TableColumn>
      </TableHeader>
      <TableBody emptyState={empty}>
        {products.map((product) => (
          <RowLink
            key={product.id}
            accessibilityLabel={`${t('product.title')} ${product.name}`}
            onPress={() => router.push({ pathname: '/products/[id]', params: { id: product.id } })}
          >
            <TableRow>
              <TableCell {...COLUMNS.name}>
                <View>
                  <Text variant="body-2-medium" numberOfLines={1}>
                    {product.name}
                  </Text>
                  <Text
                    variant="caption-1-regular"
                    numberOfLines={1}
                    className="text-muted-foreground"
                  >
                    {product.description ?? product.id}
                  </Text>
                </View>
              </TableCell>
              <TableCell {...COLUMNS.pricing}>
                <Text
                  variant="body-2-regular"
                  numberOfLines={1}
                  className={product.default_price === null ? 'text-muted-foreground' : 'font-mono'}
                >
                  {product.default_price === null
                    ? t('products.noPrice')
                    : typeof product.default_price === 'string'
                      ? product.default_price
                      : product.default_price.id}
                </Text>
              </TableCell>
              <TableCell {...COLUMNS.status}>
                <Badge
                  appearance="subtle"
                  tone={product.active ? 'success' : 'neutral'}
                  size="label-small"
                  content={product.active ? t('products.active') : t('products.archived')}
                />
              </TableCell>
              <TableCell {...COLUMNS.created}>
                <Timestamp seconds={product.created} muted />
              </TableCell>
              <TableCell {...COLUMNS.updated}>
                <Timestamp seconds={product.updated} muted />
              </TableCell>
            </TableRow>
          </RowLink>
        ))}
      </TableBody>
    </Table>
  );
}

function ProductList({
  scope,
  filter,
  adding,
  onAdd,
}: {
  scope: DashboardScope;
  filter: ProductFilter;
  adding: boolean;
  onAdd: () => void;
}) {
  const pages = useProductPages(scope, filter);
  if (pages.isPending) {
    return <PageSkeleton variant="table" accessibilityLabel={t('products.title')} />;
  }
  if (pages.isError)
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  const products = pages.data.pages.flatMap((page) => page.data);
  return (
    <View className="gap-6">
      {adding ? <AddProduct scope={scope} /> : null}
      <View className="gap-4">
        <ProductsTable
          products={products}
          empty={
            filter === true ? (
              <ListEmpty
                title={t('products.empty.firstTitle')}
                description={t('products.empty.firstBody')}
                action={{ label: t('products.add'), onPress: onAdd }}
                docs="catalog"
              />
            ) : (
              <EmptyState
                variant="compact"
                title={t('products.empty.title')}
                description={t('products.empty.body')}
              />
            )
          }
        />
        <ListFooter pages={pages} />
      </View>
    </View>
  );
}

export default function ProductsScreen() {
  const [filter, setFilter] = useState<ProductFilter>(true);
  const [adding, setAdding] = useState(false);
  return (
    <OrbitScreen
      title={t('products.title')}
      description={t('products.description')}
      actions={
        <Button
          appearance={adding ? 'outline' : 'solid'}
          tone={adding ? undefined : 'accent'}
          size="sm"
          onPress={() => setAdding((open) => !open)}
        >
          {adding ? t('action.cancel') : t('products.add')}
        </Button>
      }
      filters={<ActiveFilter value={filter} onChange={setFilter} />}
    >
      {({ scope }) => (
        <ProductList scope={scope} filter={filter} adding={adding} onAdd={() => setAdding(true)} />
      )}
    </OrbitScreen>
  );
}
