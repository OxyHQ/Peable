import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CheckoutLineItem, Price, Quote } from '@peable.to/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '../api/client';
import type { DashboardScope } from '../api/dashboard';
import { describeError, isOrbitApiError } from '../api/transport';
import { billingKeys, useCustomerPages } from '../billing/useBilling';
import { formatInstant } from '../format/time';
import { t } from '../i18n';
import { PricePicker, priceChoiceOf } from '../links/LinkLinesEditor';
import { Choice } from '../ui/Choice';
import { FormField } from '../ui/FormField';
import { ErrorNotice, Section } from '../ui/OrbitScreen';
import { Toggle } from '../ui/Toggle';
import {
  buildCreateQuoteBody,
  buildUpdateQuoteBody,
  EMPTY_QUOTE_FORM,
  hasRecurring,
  intervalOf,
  lineForQuote,
  type QuoteDiscountKind,
  type QuoteForm,
  type QuoteFormErrors,
  type QuoteLineForm,
  type QuotePriceChoice,
  quoteCurrency,
  quoteFormOf,
  quotePriceRefusal,
  serverQuoteErrors,
} from './quoteForm';

function hint(errors: QuoteFormErrors, field: string, fallback?: string): string | undefined {
  const code = errors[field];
  return code ? t(`quote.error.${code}`) : fallback;
}

/** A catalog Price as the quote builder holds it. */
function choiceOf(price: Price, productName: string): QuotePriceChoice {
  return { ...priceChoiceOf(price, { name: productName }), interval: intervalOf(price) };
}

/** A stored line (its Price expanded) as the builder's line. */
export function lineOfItem(item: CheckoutLineItem): QuoteLineForm | null {
  const price = item.price as Price | string | null;
  if (price === null || typeof price === 'string') return null;
  return { price: choiceOf(price, item.description), quantity: String(item.quantity) };
}

function CustomerPicker({
  scope,
  value,
  onChange,
  invalid,
  disabled,
}: {
  scope: DashboardScope;
  value: string;
  onChange: (customer: string) => void;
  invalid: string | undefined;
  disabled: boolean;
}) {
  const [email, setEmail] = useState('');
  const [query, setQuery] = useState('');
  const customers = useCustomerPages(scope, query);
  const list = customers.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <View className="gap-3">
      <View className="flex-row flex-wrap items-end gap-3">
        <View className="flex-1 min-w-56">
          <FormField
            label={t('quote.form.customerEmail')}
            hint={t('quote.form.customerEmailHint')}
            value={email}
            onChange={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            disabled={disabled}
          />
        </View>
        <Button
          appearance="outline"
          size="sm"
          disabled={disabled}
          onPress={() => setQuery(email.trim())}
        >
          {t('customers.search')}
        </Button>
      </View>
      {customers.isPending ? (
        <Loading accessibilityLabel={t('quote.form.customerPick')} />
      ) : customers.isError ? (
        <ErrorNotice error={customers.error} onRetry={() => void customers.refetch()} />
      ) : list.length === 0 ? (
        <Text variant="body-2-regular" className="text-muted-foreground">
          {t('quote.form.noCustomers')}
        </Text>
      ) : (
        <Choice
          label={t('quote.form.customerPick')}
          value={value || null}
          options={list.map((customer) => ({
            value: customer.id,
            label: [customer.name, customer.email, customer.id].filter(Boolean).join(' · '),
          }))}
          onChange={onChange}
          disabled={disabled}
        />
      )}
      {invalid ? (
        <Text variant="caption-1-regular" className="text-destructive" accessibilityRole="alert">
          {invalid}
        </Text>
      ) : null}
    </View>
  );
}

function LinesEditor({
  scope,
  lines,
  onChange,
  errors,
  disabled,
}: {
  scope: DashboardScope;
  lines: QuoteLineForm[];
  onChange: (lines: QuoteLineForm[]) => void;
  errors: QuoteFormErrors;
  disabled: boolean;
}) {
  return (
    <View className="gap-3">
      {lines.map((line, index) => {
        const at = `line_items[${index}]`;
        const priceError = hint(errors, `${at}[price]`);
        return (
          <View key={line.price.id} className="gap-3 py-3 border-b border-border">
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
              <Button
                appearance="plain"
                tone="danger"
                size="sm"
                disabled={disabled}
                onPress={() => onChange(lines.filter((_, i) => i !== index))}
              >
                {t('quote.form.removeLine')}
              </Button>
            </View>
            <View className="w-32">
              <FormField
                label={t('quote.form.quantity')}
                value={line.quantity}
                onChange={(quantity) =>
                  onChange(lines.map((each, i) => (i === index ? { ...each, quantity } : each)))
                }
                keyboardType="number-pad"
                invalid={Boolean(errors[`${at}[quantity]`])}
                {...(hint(errors, `${at}[quantity]`)
                  ? { hint: hint(errors, `${at}[quantity]`) }
                  : {})}
                disabled={disabled}
              />
            </View>
          </View>
        );
      })}
      {errors.line_items ? (
        <Text variant="caption-1-regular" className="text-destructive" accessibilityRole="alert">
          {hint(errors, 'line_items')}
        </Text>
      ) : null}
      <PricePicker
        scope={scope}
        disabled={disabled}
        addLabel={t('quote.form.addLine')}
        refuse={(choice, price) => {
          if (price.recurring?.usage_type === 'metered') return t('quote.error.metered');
          const refusal = quotePriceRefusal(lines, choiceOf(price, choice.productName));
          return refusal ? t(`quote.error.${refusal}`) : null;
        }}
        onAdd={(choice, price) =>
          onChange([...lines, lineForQuote(choiceOf(price, choice.productName))])
        }
      />
    </View>
  );
}

const collectionOptions = () =>
  (['charge_automatically', 'send_invoice'] as const).map((value) => ({
    value,
    label: t(`collection.${value}`),
  }));

const discountOptions = () =>
  (['none', 'coupon', 'promotion_code'] as const).map((value) => ({
    value,
    label: t(`quote.form.discount.${value}`),
  }));

/**
 * The quote builder: a new draft for a customer, or (`quote`) a draft's
 * fields restated and saved whole. The gateway prices it again either way.
 */
export function QuoteBuilder({
  scope,
  quote,
  initialLines = [],
}: {
  scope: DashboardScope;
  /** The draft being edited; absent for a new quote. */
  quote?: Quote;
  initialLines?: QuoteLineForm[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<QuoteForm>(
    quote ? quoteFormOf(quote, initialLines) : EMPTY_QUOTE_FORM,
  );
  const [errors, setErrors] = useState<QuoteFormErrors>({});
  const set =
    <K extends keyof QuoteForm>(key: K) =>
    (value: QuoteForm[K]) =>
      setForm((current) => ({ ...current, [key]: value }));
  const save = useMutation({
    mutationFn: (now: number) => {
      if (quote) {
        const built = buildUpdateQuoteBody(form, now);
        if (!built.ok) throw new FormRefusal(built.errors);
        return dashboardApi.quotes.update(scope, quote.id, built.body);
      }
      const built = buildCreateQuoteBody(form, now);
      if (!built.ok) throw new FormRefusal(built.errors);
      return dashboardApi.quotes.create(scope, built.body);
    },
    onSuccess: (saved) => {
      toast.success(t(quote ? 'quote.form.saved' : 'quote.form.created'));
      setErrors({});
      void queryClient.invalidateQueries({ queryKey: billingKeys.all(scope) });
      router.replace({ pathname: '/quotes/[id]', params: { id: saved.id } });
    },
    onError: (error) => {
      if (error instanceof FormRefusal) {
        setErrors(error.errors);
        toast.error(t('quote.form.fixErrors'));
        return;
      }
      if (isOrbitApiError(error)) setErrors(serverQuoteErrors(error.param));
      toast.error(describeError(error, t('error.generic')));
    },
  });
  const disabled = save.isPending;
  const currency = quoteCurrency(form.lines);
  const fieldHint = (field: string, fallback?: string) => {
    const text = hint(errors, field, fallback);
    return text ? { hint: text } : {};
  };
  return (
    <View className="gap-6">
      <Section
        title={t('quote.form.customer')}
        {...(quote ? { description: t('quote.form.customerFixed') } : {})}
      >
        {quote ? (
          <Text variant="body-2-regular" className="font-mono" selectable>
            {form.customer}
          </Text>
        ) : (
          <CustomerPicker
            scope={scope}
            value={form.customer}
            onChange={set('customer')}
            invalid={hint(errors, 'customer')}
            disabled={disabled}
          />
        )}
      </Section>
      <Section
        title={t('quote.form.lines')}
        description={
          currency ? t('quote.form.linesCurrency', { currency }) : t('quote.form.linesIntro')
        }
      >
        <LinesEditor
          scope={scope}
          lines={form.lines}
          onChange={set('lines')}
          errors={errors}
          disabled={disabled}
        />
      </Section>
      <Section title={t('quote.form.terms')}>
        <View className="gap-4">
          <Choice
            label={t('quote.form.collection')}
            value={form.collectionMethod}
            options={collectionOptions()}
            onChange={(next) => set('collectionMethod')(next as QuoteForm['collectionMethod'])}
            disabled={disabled}
          />
          {errors.collection_method ? (
            <Text variant="caption-1-regular" className="text-destructive">
              {hint(errors, 'collection_method')}
            </Text>
          ) : null}
          {form.collectionMethod === 'send_invoice' ? (
            <FormField
              label={t('quote.form.daysUntilDue')}
              value={form.daysUntilDue}
              onChange={set('daysUntilDue')}
              keyboardType="number-pad"
              invalid={Boolean(errors['invoice_settings[days_until_due]'])}
              {...fieldHint('invoice_settings[days_until_due]', t('quote.form.daysUntilDueHint'))}
              disabled={disabled}
            />
          ) : null}
          <Choice
            label={t('quote.form.discount')}
            value={form.discountKind}
            options={discountOptions()}
            onChange={(next) => set('discountKind')(next as QuoteDiscountKind)}
            disabled={disabled}
          />
          {form.discountKind !== 'none' ? (
            <FormField
              label={t('quote.form.discountId')}
              value={form.discountId}
              onChange={set('discountId')}
              autoCapitalize="none"
              invalid={Boolean(errors.discounts)}
              {...fieldHint('discounts', t('quote.form.discountIdHint'))}
              disabled={disabled}
            />
          ) : null}
          <FormField
            label={t('quote.form.expires')}
            value={form.expiresInDays}
            onChange={set('expiresInDays')}
            keyboardType="number-pad"
            invalid={Boolean(errors.expires_at)}
            {...fieldHint(
              'expires_at',
              quote
                ? t('quote.form.expiresKeep', { date: formatInstant(quote.expires_at) })
                : t('quote.form.expiresHint'),
            )}
            disabled={disabled}
          />
          {hasRecurring(form.lines) || form.trialDays ? (
            <FormField
              label={t('quote.form.trial')}
              value={form.trialDays}
              onChange={set('trialDays')}
              keyboardType="number-pad"
              invalid={Boolean(errors['subscription_data[trial_period_days]'])}
              {...fieldHint('subscription_data[trial_period_days]', t('quote.form.trialHint'))}
              disabled={disabled}
            />
          ) : null}
          <Toggle
            label={t('quote.form.automaticTax')}
            hint={t('quote.form.automaticTaxHint')}
            value={form.automaticTax}
            onChange={set('automaticTax')}
            disabled={disabled}
          />
        </View>
      </Section>
      <Section title={t('quote.form.text')}>
        <View className="gap-4">
          <FormField
            label={t('quote.form.header')}
            value={form.header}
            onChange={set('header')}
            invalid={Boolean(errors.header)}
            {...fieldHint('header')}
            disabled={disabled}
          />
          <FormField
            label={t('quote.form.description')}
            value={form.description}
            onChange={set('description')}
            multiline
            invalid={Boolean(errors.description)}
            {...fieldHint('description')}
            disabled={disabled}
          />
          <FormField
            label={t('quote.form.footer')}
            value={form.footer}
            onChange={set('footer')}
            multiline
            invalid={Boolean(errors.footer)}
            {...fieldHint('footer')}
            disabled={disabled}
          />
        </View>
      </Section>
      <View className="flex-row flex-wrap items-center justify-end gap-3">
        {Object.keys(errors).length > 0 ? (
          <Text variant="caption-1-regular" className="text-destructive">
            {t('quote.form.fixErrors')}
          </Text>
        ) : null}
        <Button
          appearance="solid"
          tone="accent"
          loading={save.isPending}
          onPress={() => save.mutate(Math.floor(Date.now() / 1000))}
        >
          {t(quote ? 'quote.form.save' : 'quote.form.create')}
        </Button>
      </View>
    </View>
  );
}

/** A form the builder refused before sending, with the fields it marks. */
class FormRefusal extends Error {
  constructor(readonly errors: QuoteFormErrors) {
    super('the quote form has errors');
  }
}
