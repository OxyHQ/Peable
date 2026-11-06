import { View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CheckoutLocale, Customer } from '@peable.to/shared-types';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { billingKeys } from '@/billing/useBilling';
import { t } from '@/i18n';
import { ORBIT_CHECKOUT_LOCALES } from '@/links/linkForm';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { Choice } from '@/ui/Choice';
import { PermissionNotice } from '@/ui/states';

/** The select's value for a customer with no preferred language. */
export const NO_CUSTOMER_LANGUAGE = 'none';

/**
 * What choosing `value` writes: Stripe's dashboard sets ONE language, so a
 * choice replaces the list with it, and "none" clears it.
 */
export function preferredLocalesFor(value: string): CheckoutLocale[] {
  return value === NO_CUSTOMER_LANGUAGE ? [] : [value as CheckoutLocale];
}

const options = () => [
  { value: NO_CUSTOMER_LANGUAGE, label: t('customer.language.none') },
  ...ORBIT_CHECKOUT_LOCALES.map((value) => ({ value, label: t(`links.locale.${value}`) })),
];

/**
 * The customer's language (`preferred_locales`): receipts, invoices and
 * dunning emails are written in its first entry. Editing it needs
 * `billing:manage`, the gate every customer write sits behind.
 */
export function CustomerLanguage({
  scope,
  customer,
}: {
  scope: DashboardScope;
  customer: Customer;
}) {
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const save = useMutation({
    mutationFn: (value: string) =>
      dashboardApi.customers.update(scope, customer.id, {
        preferred_locales: preferredLocalesFor(value),
      }),
    onSuccess: () => {
      toast.success(t('customer.language.saved'));
      void queryClient.invalidateQueries({ queryKey: billingKeys.customer(scope, customer.id) });
    },
    onError: (error: unknown) => toast.error(describeError(error, t('error.generic'))),
  });
  const current = customer.preferred_locales[0] ?? NO_CUSTOMER_LANGUAGE;
  return (
    <View className="gap-2">
      <Choice
        label={t('customer.field.language')}
        value={save.isPending && save.variables ? save.variables : current}
        options={options()}
        onChange={(value) => {
          if (value !== current) save.mutate(value);
        }}
        disabled={!can('money') || save.isPending}
        size="sm"
      />
      {customer.preferred_locales.length > 1 ? (
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {t('customer.language.list', {
            languages: customer.preferred_locales
              .map((locale) => t(`links.locale.${locale}`))
              .join(', '),
          })}
        </Text>
      ) : null}
      <Text variant="caption-1-regular" className="text-muted-foreground">
        {t('customer.language.help')}
      </Text>
      <PermissionNotice action="money" />
    </View>
  );
}
