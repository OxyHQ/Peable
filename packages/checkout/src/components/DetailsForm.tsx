import { type ReactNode, useId } from 'react';
import {
  type AddressParams,
  CHECKOUT_TAX_ID_TYPES,
  type CheckoutSessionPublic,
  type CheckoutTaxIdType,
  type UpdateCheckoutSessionPublicParams,
} from '@peable.to/shared-types';
import { useI18n } from '../i18n';

export interface AddressDraft {
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
}

/** Everything the payer can type, kept locally until it is sent with the order. */
export interface DetailsDraft {
  email: string;
  name: string;
  phone: string;
  address: AddressDraft;
  shippingName: string;
  shipping: AddressDraft;
  taxIdType: CheckoutTaxIdType;
  taxIdValue: string;
  custom: Record<string, string>;
  terms: boolean;
}

const EMPTY_ADDRESS: AddressDraft = {
  line1: '',
  line2: '',
  city: '',
  state: '',
  postal_code: '',
  country: '',
};

function addressDraft(address: CheckoutSessionPublic['customer_details']['address']): AddressDraft {
  if (!address) return { ...EMPTY_ADDRESS };
  return {
    line1: address.line1 ?? '',
    line2: address.line2 ?? '',
    city: address.city ?? '',
    state: address.state ?? '',
    postal_code: address.postal_code ?? '',
    country: address.country ?? '',
  };
}

export function draftFromSession(session: CheckoutSessionPublic): DetailsDraft {
  const details = session.customer_details;
  const taxId = details.tax_ids[0];
  const custom: Record<string, string> = {};
  for (const field of session.custom_fields) {
    custom[field.key] = field.dropdown?.value ?? field.text?.value ?? field.numeric?.value ?? '';
  }
  return {
    email: details.email ?? '',
    name: details.name ?? '',
    phone: details.phone ?? '',
    address: addressDraft(details.address),
    shippingName: session.shipping_details?.name ?? '',
    shipping: addressDraft(session.shipping_details?.address ?? null),
    taxIdType: taxId?.type ?? 'eu_vat',
    taxIdValue: taxId?.value ?? '',
    custom,
    terms: session.consent?.terms_of_service === 'accepted',
  };
}

/** Whether the session asks for a billing address. */
export function collectsBillingAddress(session: CheckoutSessionPublic): boolean {
  return session.billing_address_collection === 'required' || session.automatic_tax.enabled;
}

function addressParams(draft: AddressDraft): AddressParams | undefined {
  const params: AddressParams = {};
  for (const key of Object.keys(draft) as (keyof AddressDraft)[]) {
    const value = draft[key].trim();
    if (value) params[key] = key === 'country' ? value.toUpperCase() : value;
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * The update a draft becomes. Only what the session collects, and only what
 * the payer filled in: an empty field is absent, so the gateway's "required"
 * answer names it instead of a malformed one. `customKeys` is the order the
 * custom fields were sent in, to read an index-named refusal back.
 */
export function paramsFromDraft(
  draft: DetailsDraft,
  session: CheckoutSessionPublic,
): { params: UpdateCheckoutSessionPublicParams; customKeys: string[] } {
  const details: NonNullable<UpdateCheckoutSessionPublicParams['customer_details']> = {};
  if (!session.customer_email_locked && draft.email.trim()) details.email = draft.email.trim();
  if (draft.name.trim()) details.name = draft.name.trim();
  if (session.phone_number_collection.enabled && draft.phone.trim()) {
    details.phone = draft.phone.trim();
  }
  if (collectsBillingAddress(session)) {
    const address = addressParams(draft.address);
    if (address) details.address = address;
  }
  if (session.tax_id_collection.enabled && draft.taxIdValue.trim()) {
    details.tax_ids = [{ type: draft.taxIdType, value: draft.taxIdValue.trim() }];
  }
  const params: UpdateCheckoutSessionPublicParams = {};
  if (Object.keys(details).length > 0) params.customer_details = details;
  if (session.shipping_address_collection) {
    const address = addressParams(draft.shipping);
    if (address && draft.shippingName.trim()) {
      params.shipping_details = { name: draft.shippingName.trim(), address };
    }
  }
  const customKeys: string[] = [];
  const custom: { key: string; value: string }[] = [];
  for (const field of session.custom_fields) {
    const value = (draft.custom[field.key] ?? '').trim();
    if (!value) continue;
    customKeys.push(field.key);
    custom.push({ key: field.key, value });
  }
  if (custom.length > 0) params.custom_fields = custom;
  if (session.consent_collection?.terms_of_service === 'required' && draft.terms) {
    params.consent = { terms_of_service: 'accepted' };
  }
  return { params, customKeys };
}

/** Every field name this form renders, as the gateway's dotted `param`. */
export function detailsFieldNames(session: CheckoutSessionPublic): string[] {
  const names = ['customer_details.name'];
  if (session.contact_collection !== 'merchant_account' || session.customer_details.email) {
    names.push('customer_details.email');
  }
  const address = (prefix: string) =>
    ['line1', 'line2', 'city', 'state', 'postal_code', 'country'].map(
      (part) => `${prefix}.${part}`,
    );
  if (session.phone_number_collection.enabled) names.push('customer_details.phone');
  if (collectsBillingAddress(session)) {
    names.push('customer_details.address', ...address('customer_details.address'));
  }
  if (session.shipping_address_collection) {
    names.push(
      'shipping_details',
      'shipping_details.name',
      'shipping_details.address',
      ...address('shipping_details.address'),
    );
  }
  if (session.tax_id_collection.enabled) {
    names.push(
      'customer_details.tax_ids',
      'customer_details.tax_ids.0.type',
      'customer_details.tax_ids.0.value',
    );
  }
  for (const field of session.custom_fields) names.push(`custom_fields.${field.key}`);
  if (session.consent_collection?.terms_of_service === 'required') {
    names.push('consent.terms_of_service');
  }
  return names;
}

function Field({
  label,
  optional,
  error,
  children,
}: {
  label: string;
  optional?: boolean;
  error: string | null;
  children: (props: {
    id: string;
    'aria-invalid': boolean;
    'aria-describedby': string | undefined;
  }) => ReactNode;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {optional ? <span className="field__optional"> {t('optional')}</span> : null}
      </label>
      {children({
        id,
        'aria-invalid': error !== null,
        'aria-describedby': error ? `${id}-error` : undefined,
      })}
      {error && (
        <p id={`${id}-error`} className="field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function AddressFields({
  prefix,
  value,
  onChange,
  errorFor,
  countries,
  disabled,
}: {
  prefix: string;
  value: AddressDraft;
  onChange: (next: AddressDraft) => void;
  errorFor: (param: string) => string | null;
  /** Restricts the country to a list (shipping); free 2-letter code otherwise. */
  countries?: readonly string[] | undefined;
  disabled: boolean;
}) {
  const { t, locale } = useI18n();
  const set = (key: keyof AddressDraft) => (next: string) => onChange({ ...value, [key]: next });
  let regionName: (code: string) => string = (code) => code;
  try {
    const names = new Intl.DisplayNames([locale], { type: 'region' });
    regionName = (code) => names.of(code) ?? code;
  } catch {
    // Older engines: show the code.
  }
  const text = (key: keyof AddressDraft, label: string, autoComplete: string, optional = false) => (
    <Field label={label} optional={optional} error={errorFor(`${prefix}.${key}`)}>
      {(props) => (
        <input
          {...props}
          value={value[key]}
          autoComplete={autoComplete}
          disabled={disabled}
          onChange={(event) => set(key)(event.target.value)}
        />
      )}
    </Field>
  );
  return (
    <div className="address">
      {countries ? (
        <Field label={t('countrySelect')} error={errorFor(`${prefix}.country`)}>
          {(props) => (
            <select
              {...props}
              value={value.country}
              autoComplete="country"
              disabled={disabled}
              onChange={(event) => set('country')(event.target.value)}
            >
              <option value="">{t('selectOption')}</option>
              {countries.map((code) => (
                <option key={code} value={code}>
                  {regionName(code)}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : (
        <Field label={t('country')} error={errorFor(`${prefix}.country`)}>
          {(props) => (
            <input
              {...props}
              value={value.country}
              autoComplete="country"
              maxLength={2}
              disabled={disabled}
              onChange={(event) => set('country')(event.target.value.toUpperCase())}
            />
          )}
        </Field>
      )}
      {text('line1', t('line1'), 'address-line1')}
      {text('line2', t('line2'), 'address-line2', true)}
      <div className="address__row">
        {text('postal_code', t('postalCode'), 'postal-code')}
        {text('city', t('city'), 'address-level2')}
      </div>
      {text('state', t('state'), 'address-level1', true)}
    </div>
  );
}

/**
 * What the session collects from the payer. Validation is the gateway's: a
 * refusal comes back naming the field (`param`), and is shown at it.
 */
export function DetailsForm({
  session,
  draft,
  onChange,
  errorFor,
  disabled,
}: {
  session: CheckoutSessionPublic;
  draft: DetailsDraft;
  onChange: (next: DetailsDraft) => void;
  errorFor: (param: string) => string | null;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const set = <K extends keyof DetailsDraft>(key: K, value: DetailsDraft[K]) =>
    onChange({ ...draft, [key]: value });
  const termsId = useId();

  return (
    <div className="details">
      <section className="details__section" aria-labelledby="contact-heading">
        <h2 id="contact-heading" className="section-heading">
          {t('contactInfo')}
        </h2>
        {(session.contact_collection !== 'merchant_account' || session.customer_details.email) && (
          <Field label={t('email')} error={errorFor('customer_details.email')}>
            {(props) => (
              <input
                {...props}
                type="email"
                autoComplete="email"
                value={draft.email}
                readOnly={session.customer_email_locked}
                disabled={disabled}
                onChange={(event) => set('email', event.target.value)}
              />
            )}
          </Field>
        )}
        <Field
          label={t('name')}
          optional={!collectsBillingAddress(session)}
          error={errorFor('customer_details.name')}
        >
          {(props) => (
            <input
              {...props}
              autoComplete="name"
              value={draft.name}
              disabled={disabled}
              onChange={(event) => set('name', event.target.value)}
            />
          )}
        </Field>
        {session.phone_number_collection.enabled && (
          <Field label={t('phone')} error={errorFor('customer_details.phone')}>
            {(props) => (
              <input
                {...props}
                type="tel"
                autoComplete="tel"
                value={draft.phone}
                disabled={disabled}
                onChange={(event) => set('phone', event.target.value)}
              />
            )}
          </Field>
        )}
      </section>

      {session.shipping_address_collection && (
        <section className="details__section" aria-labelledby="shipping-heading">
          <h2 id="shipping-heading" className="section-heading">
            {t('shippingAddress')}
          </h2>
          {(errorFor('shipping_details') ?? errorFor('shipping_details.address')) && (
            <p className="field__error" role="alert">
              {errorFor('shipping_details') ?? errorFor('shipping_details.address')}
            </p>
          )}
          <Field label={t('shippingName')} error={errorFor('shipping_details.name')}>
            {(props) => (
              <input
                {...props}
                autoComplete="shipping name"
                value={draft.shippingName}
                disabled={disabled}
                onChange={(event) => set('shippingName', event.target.value)}
              />
            )}
          </Field>
          <AddressFields
            prefix="shipping_details.address"
            value={draft.shipping}
            onChange={(next) => set('shipping', next)}
            errorFor={errorFor}
            countries={session.shipping_address_collection.allowed_countries}
            disabled={disabled}
          />
        </section>
      )}

      {collectsBillingAddress(session) && (
        <section className="details__section" aria-labelledby="billing-heading">
          <h2 id="billing-heading" className="section-heading">
            {t('billingAddress')}
          </h2>
          {errorFor('customer_details.address') && (
            <p className="field__error" role="alert">
              {errorFor('customer_details.address')}
            </p>
          )}
          <AddressFields
            prefix="customer_details.address"
            value={draft.address}
            onChange={(next) => set('address', next)}
            errorFor={errorFor}
            disabled={disabled}
          />
        </section>
      )}

      {session.tax_id_collection.enabled && (
        <section className="details__section details__row">
          <Field
            label={t('taxIdType')}
            optional
            error={errorFor('customer_details.tax_ids.0.type')}
          >
            {(props) => (
              <select
                {...props}
                value={draft.taxIdType}
                disabled={disabled}
                onChange={(event) => {
                  const value = event.target.value;
                  const type = CHECKOUT_TAX_ID_TYPES.find((candidate) => candidate === value);
                  if (type) set('taxIdType', type);
                }}
              >
                {CHECKOUT_TAX_ID_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type.toUpperCase().replace('_', ' ')}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            label={t('taxIdValue')}
            optional
            error={
              errorFor('customer_details.tax_ids.0.value') ?? errorFor('customer_details.tax_ids')
            }
          >
            {(props) => (
              <input
                {...props}
                value={draft.taxIdValue}
                disabled={disabled}
                onChange={(event) => set('taxIdValue', event.target.value)}
              />
            )}
          </Field>
        </section>
      )}

      {session.custom_fields.length > 0 && (
        <section className="details__section">
          {session.custom_fields.map((field) => {
            const value = draft.custom[field.key] ?? '';
            const update = (next: string) => set('custom', { ...draft.custom, [field.key]: next });
            return (
              <Field
                key={field.key}
                label={field.label.custom}
                optional={field.optional}
                error={errorFor(`custom_fields.${field.key}`)}
              >
                {(props) =>
                  field.type === 'dropdown' ? (
                    <select
                      {...props}
                      value={value}
                      disabled={disabled}
                      onChange={(event) => update(event.target.value)}
                    >
                      <option value="">{t('selectOption')}</option>
                      {(field.dropdown?.options ?? []).map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      {...props}
                      value={value}
                      inputMode={field.type === 'numeric' ? 'numeric' : undefined}
                      pattern={field.type === 'numeric' ? '[0-9]*' : undefined}
                      minLength={
                        (field.type === 'numeric' ? field.numeric : field.text)?.minimum_length ??
                        undefined
                      }
                      maxLength={
                        (field.type === 'numeric' ? field.numeric : field.text)?.maximum_length ??
                        undefined
                      }
                      disabled={disabled}
                      onChange={(event) =>
                        update(
                          field.type === 'numeric'
                            ? event.target.value.replace(/[^0-9]/g, '')
                            : event.target.value,
                        )
                      }
                    />
                  )
                }
              </Field>
            );
          })}
        </section>
      )}

      {session.consent_collection?.terms_of_service === 'required' && (
        <div className="field field--checkbox">
          <input
            id={termsId}
            type="checkbox"
            checked={draft.terms}
            disabled={disabled}
            aria-invalid={errorFor('consent.terms_of_service') !== null}
            onChange={(event) => set('terms', event.target.checked)}
          />
          <label htmlFor={termsId}>
            {t('consentPrefix')}{' '}
            {session.terms_of_service_url ? (
              <a href={session.terms_of_service_url} target="_blank" rel="noreferrer noopener">
                {t('termsLink')}
              </a>
            ) : (
              t('termsLink')
            )}
          </label>
          {errorFor('consent.terms_of_service') && (
            <p className="field__error" role="alert">
              {errorFor('consent.terms_of_service')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
