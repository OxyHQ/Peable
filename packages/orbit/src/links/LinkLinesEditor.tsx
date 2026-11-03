import { useState } from 'react';
import { View } from 'react-native';
import type { Price, Product } from '@peable.to/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import type { DashboardScope } from '@/api/dashboard';
import { formatPriceLabel } from '@/catalog/productForm';
import { useProductPages, useProductPrices } from '@/catalog/useCatalog';
import { t } from '@/i18n';
import { Choice } from '@/ui/Choice';
import { FormField } from '@/ui/FormField';
import { ErrorNotice } from '@/ui/OrbitScreen';
import { Toggle } from '@/ui/Toggle';
import { errorHint } from './LinkOptionsFields';
import {
  lineFor,
  type LinkFormErrors,
  type LinkLineForm,
  type LinkPriceChoice,
  priceRefusal,
} from './linkForm';

/** A catalog price as the builder holds it. */
export function priceChoiceOf(price: Price, product: Pick<Product, 'name'>): LinkPriceChoice {
  return {
    id: price.id,
    currency: price.currency,
    type: price.type,
    active: price.active,
    label: formatPriceLabel(price),
    productName: product.name,
  };
}

function PricePicker({
  scope,
  lines,
  onAdd,
  disabled,
}: {
  scope: DashboardScope;
  lines: readonly LinkLineForm[];
  onAdd: (price: LinkPriceChoice) => void;
  disabled: boolean;
}) {
  const products = useProductPages(scope, true);
  const [productId, setProductId] = useState<string | null>(null);
  const [priceId, setPriceId] = useState<string | null>(null);
  const prices = useProductPrices(scope, productId ?? '', productId !== null);
  if (products.isPending) return <Loading accessibilityLabel={t('links.pickProduct')} />;
  if (products.isError) {
    return <ErrorNotice error={products.error} onRetry={() => void products.refetch()} />;
  }
  const productList = products.data.pages.flatMap((page) => page.data);
  if (productList.length === 0) {
    return (
      <Text variant="body-2-regular" className="text-muted-foreground">
        {t('links.noProducts')}
      </Text>
    );
  }
  const product = productList.find((each) => each.id === productId) ?? null;
  const priceList =
    productId && prices.data
      ? prices.data.pages.flatMap((page) => page.data).filter((price) => price.active)
      : [];
  const chosen = priceList.find((price) => price.id === priceId) ?? null;
  const choice = chosen && product ? priceChoiceOf(chosen, product) : null;
  const refusal = choice ? priceRefusal(lines, choice) : null;
  return (
    <View className="gap-3 rounded-xl border border-border p-3">
      <View className="flex-row flex-wrap gap-4">
        <View className="flex-1 min-w-48">
          <Choice
            label={t('links.pickProduct')}
            value={productId}
            options={productList.map((each) => ({ value: each.id, label: each.name }))}
            onChange={(next) => {
              setProductId(next);
              setPriceId(null);
            }}
            disabled={disabled}
          />
        </View>
        <View className="flex-1 min-w-48">
          {productId && prices.isPending ? (
            <Loading accessibilityLabel={t('links.pickPrice')} />
          ) : (
            <Choice
              label={t('links.pickPrice')}
              value={priceId}
              options={priceList.map((price) => ({
                value: price.id,
                label: `${formatPriceLabel(price)}${
                  price.type === 'recurring' ? ` · ${t('links.recurringPrice')}` : ''
                }`,
              }))}
              onChange={setPriceId}
              disabled={disabled || !productId || priceList.length === 0}
            />
          )}
        </View>
      </View>
      {productId && prices.data && priceList.length === 0 ? (
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {t('links.noPrices')}
        </Text>
      ) : null}
      {refusal ? (
        <Text variant="caption-1-regular" className="text-destructive" accessibilityRole="alert">
          {t(`links.refusal.${refusal}`)}
        </Text>
      ) : null}
      <View className="flex-row justify-end">
        <Button
          appearance="outline"
          size="sm"
          disabled={disabled || !choice || refusal !== null}
          onPress={() => {
            if (!choice) return;
            onAdd(choice);
            setPriceId(null);
          }}
        >
          {t('links.addLine')}
        </Button>
      </View>
    </View>
  );
}

function LineRow({
  index,
  line,
  errors,
  disabled,
  onChange,
  onRemove,
}: {
  index: number;
  line: LinkLineForm;
  errors: LinkFormErrors;
  disabled: boolean;
  onChange: (line: LinkLineForm) => void;
  onRemove: () => void;
}) {
  const at = `line_items[${index}]`;
  const set =
    <K extends keyof LinkLineForm>(key: K) =>
    (value: LinkLineForm[K]) =>
      onChange({ ...line, [key]: value });
  const priceError = errorHint(errors, `${at}[price]`);
  return (
    <View className="gap-3 py-3 border-b border-border">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <View className="flex-1 min-w-48 gap-0.5">
          <Text variant="body-2-semibold">{line.price.productName}</Text>
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {line.price.label} · <Text className="font-mono">{line.price.id}</Text>
          </Text>
          {priceError ? (
            <Text variant="caption-1-regular" className="text-destructive">
              {priceError}
            </Text>
          ) : null}
        </View>
        <Button appearance="plain" tone="danger" size="sm" onPress={onRemove} disabled={disabled}>
          {t('links.removeLine')}
        </Button>
      </View>
      <View className="flex-row flex-wrap gap-4">
        <View className="w-32">
          <FormField
            label={t('links.quantity')}
            value={line.quantity}
            onChange={set('quantity')}
            keyboardType="number-pad"
            invalid={Boolean(errors[`${at}[quantity]`])}
            {...(errorHint(errors, `${at}[quantity]`)
              ? { hint: errorHint(errors, `${at}[quantity]`) }
              : {})}
            disabled={disabled}
          />
        </View>
        <View className="flex-1 min-w-48">
          <Toggle
            label={t('links.adjustable')}
            hint={t('links.adjustableHelp')}
            value={line.adjustable}
            onChange={set('adjustable')}
            disabled={disabled}
          />
        </View>
      </View>
      {line.adjustable ? (
        <View className="flex-row flex-wrap gap-4">
          <View className="w-32">
            <FormField
              label={t('links.minimum')}
              value={line.minimum}
              onChange={set('minimum')}
              keyboardType="number-pad"
              placeholder="0"
              invalid={Boolean(errors[`${at}[adjustable_quantity]`])}
              disabled={disabled}
            />
          </View>
          <View className="w-32">
            <FormField
              label={t('links.maximum')}
              value={line.maximum}
              onChange={set('maximum')}
              keyboardType="number-pad"
              placeholder="99"
              invalid={Boolean(errors[`${at}[adjustable_quantity]`])}
              disabled={disabled}
            />
          </View>
          {errors[`${at}[adjustable_quantity]`] ? (
            <Text variant="caption-1-regular" className="text-destructive self-center">
              {errorHint(errors, `${at}[adjustable_quantity]`)}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** The builder's lines: what is on the link, and the picker that adds a price. */
export function LinkLinesEditor({
  scope,
  lines,
  onChange,
  errors,
  disabled = false,
}: {
  scope: DashboardScope;
  lines: LinkLineForm[];
  onChange: (lines: LinkLineForm[]) => void;
  errors: LinkFormErrors;
  disabled?: boolean;
}) {
  return (
    <View className="gap-3">
      {lines.map((line, index) => (
        <LineRow
          key={line.price.id}
          index={index}
          line={line}
          errors={errors}
          disabled={disabled}
          onChange={(next) => onChange(lines.map((each, at) => (at === index ? next : each)))}
          onRemove={() => onChange(lines.filter((_, at) => at !== index))}
        />
      ))}
      {errors.line_items ? (
        <Text variant="caption-1-regular" className="text-destructive" accessibilityRole="alert">
          {errorHint(errors, 'line_items')}
        </Text>
      ) : null}
      <PricePicker
        scope={scope}
        lines={lines}
        disabled={disabled}
        onAdd={(price) => onChange([...lines, lineFor(price)])}
      />
    </View>
  );
}
