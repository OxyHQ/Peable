import { Switch } from '@oxy.so/bloom/switch';
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Text } from '@oxy.so/bloom/typography';
import { CardFormCountry } from '@oxy.so/bloom/card-form';
import { billingCountries } from './countries';
import type { SheetCheckoutDetails, SheetCheckoutPreparation } from './checkoutPreparation';

export function CheckoutPreparationFields({
  preparation,
  details,
  disabled,
  busy,
  canContinue,
  error,
  locale,
  label,
  onChange,
  onContinue,
}: {
  preparation: SheetCheckoutPreparation;
  details: SheetCheckoutDetails;
  disabled: boolean;
  busy: boolean;
  canContinue: boolean;
  error: string | null;
  locale: string;
  label(key: string): string;
  onChange(details: SheetCheckoutDetails): void;
  onContinue(): void;
}) {
  return (
    <View style={{ gap: 16 }}>
      {preparation.accountSummary && (
        <GroupedSection>
          <GroupedSectionItem
            title={preparation.accountSummary.name}
            description={preparation.accountSummary.detail}
            icon={preparation.accountSummary.avatar}
            showChevron={false}
          />
        </GroupedSection>
      )}
      {preparation.request.requiresContact !== false && (
        <TextFieldInput
          label={label('email')}
          value={details.email}
          disabled={disabled}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          onValueChange={(email) => onChange({ ...details, email })}
        />
      )}
      {preparation.request.requiresShipping && (
        <>
          {(preparation.addresses?.length ?? 0) > 0 && (
            <GroupedSection title={label('section.shipping')}>
              {preparation.addresses?.map((saved) => (
                <GroupedSectionItem
                  key={saved.id}
                  title={saved.label || saved.address.name}
                  description={[
                    saved.address.line1,
                    saved.address.line2,
                    saved.address.city,
                    saved.address.postalCode,
                    saved.address.country,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                  descriptionLines={0}
                  disabled={disabled}
                  showChevron={false}
                  accessibilityState={{ selected: details.selectedAddressId === saved.id }}
                  value={
                    details.selectedAddressId === saved.id
                      ? label('preparation.selected')
                      : undefined
                  }
                  onPress={() =>
                    onChange({
                      ...details,
                      selectedAddressId: saved.requiresReview ? null : saved.id,
                      shipping: { ...saved.address },
                    })
                  }
                />
              ))}
            </GroupedSection>
          )}
          {details.selectedAddressId ? (
            <Button
              appearance="outline"
              disabled={disabled}
              onPress={() => onChange({ ...details, selectedAddressId: null })}
            >
              {label('preparation.editAddress')}
            </Button>
          ) : (
            <>
              {(['name', 'line1', 'line2', 'city', 'state', 'postalCode', 'phone'] as const).map(
                (field) => (
                  <TextFieldInput
                    key={field}
                    label={label(
                      field === 'line1'
                        ? 'field.address'
                        : ['name', 'city', 'postalCode'].includes(field)
                          ? `field.${field}`
                          : `preparation.${field}`,
                    )}
                    value={details.shipping[field]}
                    disabled={disabled}
                    keyboardType={field === 'phone' ? 'phone-pad' : 'default'}
                    onValueChange={(value) =>
                      onChange({
                        ...details,
                        selectedAddressId: null,
                        shipping: { ...details.shipping, [field]: value },
                      })
                    }
                  />
                ),
              )}
              <CardFormCountry
                label={label('field.country')}
                value={details.shipping.country}
                countries={billingCountries(locale)}
                disabled={disabled}
                onValueChange={(country) =>
                  onChange({
                    ...details,
                    selectedAddressId: null,
                    shipping: { ...details.shipping, country },
                  })
                }
              />
            </>
          )}
          <GroupedSection>
            <GroupedSectionItem
              title={label('preparation.billingMatchesShipping')}
              showChevron={false}
              rightElement={
                <Switch
                  checked={details.useShippingForBilling === true}
                  disabled={disabled}
                  accessibilityLabel={label('preparation.billingMatchesShipping')}
                  onCheckedChange={(useShippingForBilling) =>
                    onChange({ ...details, useShippingForBilling })
                  }
                />
              }
            />
          </GroupedSection>
        </>
      )}
      {preparation.renderAdditionalDetails?.({ disabled, details })}
      {error && <Text accessibilityRole="alert">{error}</Text>}
      <Button size="lg" loading={busy} disabled={busy || !canContinue} onPress={onContinue}>
        {label('continue')}
      </Button>
    </View>
  );
}
