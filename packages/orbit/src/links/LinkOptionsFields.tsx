import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { Text } from '@oxy.so/bloom/typography';
import { t } from '@/i18n';
import { Choice } from '@/ui/Choice';
import { FormField } from '@/ui/FormField';
import { Toggle } from '@/ui/Toggle';
import {
  type CustomFieldForm,
  EMPTY_CUSTOM_FIELD,
  keyFromLabel,
  type LinkFormErrors,
  type LinkOptionsForm,
  ORBIT_CHECKOUT_LOCALES,
  ORBIT_CUSTOM_FIELD_TYPES,
  ORBIT_LINK_LIMITS,
  ORBIT_SUBMIT_TYPES,
} from './linkForm';

/** The hint for a field the form refused, or `fallback`. */
export function errorHint(errors: LinkFormErrors, field: string, fallback?: string) {
  const code = errors[field];
  return code ? t(`links.error.${code}`) : fallback;
}

const submitOptions = () =>
  ORBIT_SUBMIT_TYPES.map((value) => ({
    value,
    label: t(`links.submit.${value}`),
  }));
const localeOptions = () => [
  { value: 'auto', label: t('links.locale.auto') },
  ...ORBIT_CHECKOUT_LOCALES.map((value) => ({ value, label: t(`links.locale.${value}`) })),
];
const fieldTypeOptions = () =>
  ORBIT_CUSTOM_FIELD_TYPES.map((value) => ({
    value,
    label: t(`links.customField.type.${value}`),
  }));

function CustomFieldEditor({
  index,
  field,
  errors,
  disabled,
  onChange,
  onRemove,
}: {
  index: number;
  field: CustomFieldForm;
  errors: LinkFormErrors;
  disabled: boolean;
  onChange: (field: CustomFieldForm) => void;
  onRemove: () => void;
}) {
  const at = `custom_fields[${index}]`;
  const set = <K extends keyof CustomFieldForm>(key: K, value: CustomFieldForm[K]) =>
    onChange({ ...field, [key]: value });
  return (
    <View className="gap-3 rounded-xl border border-border p-3">
      <View className="flex-row flex-wrap gap-4">
        <View className="flex-1 min-w-48">
          <FormField
            label={t('links.customField.label')}
            value={field.label}
            onChange={(label) =>
              onChange({
                ...field,
                label,
                // Follow the label until the merchant chooses a key of their own.
                key:
                  field.key === '' || field.key === keyFromLabel(field.label)
                    ? keyFromLabel(label)
                    : field.key,
              })
            }
            autoCapitalize="sentences"
            invalid={Boolean(errors[`${at}[label]`])}
            {...(errorHint(errors, `${at}[label]`)
              ? { hint: errorHint(errors, `${at}[label]`) }
              : {})}
            disabled={disabled}
          />
        </View>
        <View className="flex-1 min-w-48">
          <FormField
            label={t('links.customField.key')}
            value={field.key}
            onChange={(key) => set('key', key)}
            invalid={Boolean(errors[`${at}[key]`])}
            hint={errorHint(errors, `${at}[key]`, t('links.customField.keyHelp'))}
            disabled={disabled}
          />
        </View>
        <View className="w-40">
          <Choice
            label={t('links.customField.type')}
            value={field.type}
            options={fieldTypeOptions()}
            onChange={(type) => set('type', type as CustomFieldForm['type'])}
            disabled={disabled}
          />
        </View>
      </View>
      {field.type === 'dropdown' ? (
        <FormField
          label={t('links.customField.options')}
          value={field.options}
          onChange={(options) => set('options', options)}
          multiline
          autoCapitalize="sentences"
          invalid={Boolean(errors[`${at}[dropdown]`])}
          hint={errorHint(errors, `${at}[dropdown]`, t('links.customField.optionsHelp'))}
          disabled={disabled}
        />
      ) : (
        <View className="flex-row flex-wrap gap-4">
          <View className="flex-1 min-w-40">
            <FormField
              label={t('links.customField.minimumLength')}
              value={field.minimumLength}
              onChange={(value) => set('minimumLength', value)}
              keyboardType="number-pad"
              invalid={Boolean(errors[`${at}[${field.type}]`])}
              {...(errorHint(errors, `${at}[${field.type}]`)
                ? { hint: errorHint(errors, `${at}[${field.type}]`) }
                : {})}
              disabled={disabled}
            />
          </View>
          <View className="flex-1 min-w-40">
            <FormField
              label={t('links.customField.maximumLength')}
              value={field.maximumLength}
              onChange={(value) => set('maximumLength', value)}
              keyboardType="number-pad"
              invalid={Boolean(errors[`${at}[${field.type}]`])}
              disabled={disabled}
            />
          </View>
        </View>
      )}
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <View className="flex-1 min-w-48">
          <Toggle
            label={t('links.customField.optional')}
            value={field.optional}
            onChange={(optional) => set('optional', optional)}
            disabled={disabled}
          />
        </View>
        <Button appearance="plain" tone="danger" size="sm" onPress={onRemove} disabled={disabled}>
          {t('links.customField.remove')}
        </Button>
      </View>
    </View>
  );
}

/** Every option of a link — the same fields on create and on edit. */
export function LinkOptionsFields({
  form,
  onChange,
  errors,
  disabled = false,
}: {
  form: LinkOptionsForm;
  onChange: (update: (prior: LinkOptionsForm) => LinkOptionsForm) => void;
  errors: LinkFormErrors;
  disabled?: boolean;
}) {
  const set =
    <K extends keyof LinkOptionsForm>(key: K) =>
    (value: LinkOptionsForm[K]) =>
      onChange((prior) => ({ ...prior, [key]: value }));
  const setField = (index: number, field: CustomFieldForm) =>
    onChange((prior) => ({
      ...prior,
      customFields: prior.customFields.map((each, at) => (at === index ? field : each)),
    }));
  return (
    <View className="gap-6">
      <View className="gap-2">
        <Text variant="body-semibold">{t('links.options.collect')}</Text>
        <Toggle
          label={t('links.options.promotionCodes')}
          value={form.allowPromotionCodes}
          onChange={set('allowPromotionCodes')}
          disabled={disabled}
        />
        <Toggle
          label={t('links.options.billingAddressRequired')}
          hint={t('links.options.billingAddressHelp')}
          value={form.billingAddress === 'required'}
          onChange={(required) => set('billingAddress')(required ? 'required' : 'auto')}
          disabled={disabled}
        />
        <Toggle
          label={t('links.options.phone')}
          value={form.phone}
          onChange={set('phone')}
          disabled={disabled}
        />
        <Toggle
          label={t('links.options.taxId')}
          value={form.taxId}
          onChange={set('taxId')}
          disabled={disabled}
        />
        <Toggle
          label={t('links.options.terms')}
          hint={t('links.options.termsHelp')}
          value={form.termsOfService}
          onChange={set('termsOfService')}
          disabled={disabled}
        />
        <Toggle
          label={t('links.options.automaticTax')}
          hint={t('links.options.automaticTaxHelp')}
          value={form.automaticTax}
          onChange={set('automaticTax')}
          disabled={disabled}
        />
        <FormField
          label={t('links.options.shippingCountries')}
          value={form.shippingCountries}
          onChange={set('shippingCountries')}
          autoCapitalize="characters"
          placeholder="ES, FR, DE"
          invalid={Boolean(errors['shipping_address_collection[allowed_countries]'])}
          hint={errorHint(
            errors,
            'shipping_address_collection[allowed_countries]',
            t('links.options.shippingCountriesHelp'),
          )}
          disabled={disabled}
        />
      </View>

      <View className="gap-3">
        <View className="flex-row flex-wrap items-center justify-between gap-2">
          <Text variant="body-semibold">{t('links.customFields')}</Text>
          <Button
            appearance="outline"
            size="sm"
            disabled={disabled || form.customFields.length >= ORBIT_LINK_LIMITS.customFieldsMax}
            onPress={() =>
              onChange((prior) => ({
                ...prior,
                customFields: [...prior.customFields, { ...EMPTY_CUSTOM_FIELD }],
              }))
            }
          >
            {t('links.customField.add')}
          </Button>
        </View>
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {errorHint(errors, 'custom_fields', t('links.customFieldsHelp'))}
        </Text>
        {form.customFields.map((field, index) => (
          <CustomFieldEditor
            // Fields have no identity of their own until saved; the position is it.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={index}
            index={index}
            field={field}
            errors={errors}
            disabled={disabled}
            onChange={(next) => setField(index, next)}
            onRemove={() =>
              onChange((prior) => ({
                ...prior,
                customFields: prior.customFields.filter((_, at) => at !== index),
              }))
            }
          />
        ))}
      </View>

      <View className="gap-3">
        <Text variant="body-semibold">{t('links.afterCompletion')}</Text>
        <SegmentedControl<LinkOptionsForm['afterCompletion']>
          label={t('links.afterCompletion')}
          type="radio"
          size="sm"
          value={form.afterCompletion}
          disabled={disabled}
          onValueChange={set('afterCompletion')}
        >
          <SegmentedControlItem value="hosted_confirmation">
            <SegmentedControlItemText>{t('links.afterCompletion.hosted')}</SegmentedControlItemText>
          </SegmentedControlItem>
          <SegmentedControlItem value="redirect">
            <SegmentedControlItemText>
              {t('links.afterCompletion.redirect')}
            </SegmentedControlItemText>
          </SegmentedControlItem>
        </SegmentedControl>
        {form.afterCompletion === 'redirect' ? (
          <FormField
            label={t('links.afterCompletion.url')}
            value={form.redirectUrl}
            onChange={set('redirectUrl')}
            keyboardType="url"
            placeholder="https://example.com/thanks?session={CHECKOUT_SESSION_ID}"
            invalid={Boolean(errors['after_completion[redirect][url]'])}
            hint={errorHint(
              errors,
              'after_completion[redirect][url]',
              t('links.afterCompletion.urlHelp'),
            )}
            disabled={disabled}
          />
        ) : (
          <FormField
            label={t('links.afterCompletion.message')}
            value={form.confirmationMessage}
            onChange={set('confirmationMessage')}
            multiline
            autoCapitalize="sentences"
            invalid={Boolean(errors['after_completion[hosted_confirmation][custom_message]'])}
            hint={errorHint(
              errors,
              'after_completion[hosted_confirmation][custom_message]',
              t('links.afterCompletion.messageHelp'),
            )}
            disabled={disabled}
          />
        )}
      </View>

      <View className="flex-row flex-wrap gap-4">
        <View className="flex-1 min-w-48">
          <FormField
            label={t('links.options.sessionsLimit')}
            value={form.sessionsLimit}
            onChange={set('sessionsLimit')}
            keyboardType="number-pad"
            invalid={Boolean(errors['restrictions[completed_sessions][limit]'])}
            hint={errorHint(
              errors,
              'restrictions[completed_sessions][limit]',
              t('links.options.sessionsLimitHelp'),
            )}
            disabled={disabled}
          />
        </View>
        <View className="flex-1 min-w-48">
          <Choice
            label={t('links.options.submitType')}
            value={form.submitType}
            options={submitOptions()}
            onChange={(value) => set('submitType')(value as LinkOptionsForm['submitType'])}
            disabled={disabled}
          />
        </View>
        <View className="flex-1 min-w-48">
          <Choice
            label={t('links.options.locale')}
            value={form.locale}
            options={localeOptions()}
            onChange={(value) => set('locale')(value as LinkOptionsForm['locale'])}
            disabled={disabled}
          />
        </View>
      </View>
    </View>
  );
}
