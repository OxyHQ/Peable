import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { CardForm, CardFormHostedField } from '@oxy.so/bloom/card-form';
import { Button } from '@oxy.so/bloom/button';
import { Text, fontFamilies, TYPE_SCALE } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { checkoutMessage } from './messages';
import { loadProviderSdk, type ProviderElement } from '../browser/providerJs';
import { prepareCardAuthorization, type ProviderCardPreparation } from './preparedCard';
import type { PeableProviderFieldsProps } from './providerFieldTypes';
import { matchingCardAction } from './cardReadiness';

type SecureField = 'number' | 'expiry' | 'securityCode';
const fields: readonly SecureField[] = ['number', 'expiry', 'securityCode'];
const providerTypes = {
  number: 'cardNumber',
  expiry: 'cardExpiry',
  securityCode: 'cardCvc',
} as const;
// Billing-address choices, not a payment-method eligibility policy.
const countryCodes =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(
    ' ',
  );

/** The same Bloom CardForm layout, with only its three sensitive inputs hosted by the processor. */
export function PeableProviderCardFields({
  action,
  cardConfiguration,
  locale = 'en',
  disabled = false,
  requirePostalCode = false,
  returnUrl,
  onReady,
  onError,
  loadingLabel = checkoutMessage(locale, 'provider.loading'),
  unavailableLabel = checkoutMessage(locale, 'provider.unavailable'),
}: PeableProviderFieldsProps) {
  const { colors } = useTheme();
  const publishableKey = cardConfiguration?.publishableKey ?? action?.publishableKey;
  const actionRef = useRef(action);
  actionRef.current = action;
  const [billing, setBilling] = useState({ country: '', postcode: '' });
  const billingRef = useRef(billing);
  billingRef.current = billing;
  const [phase, setPhase] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [retry, setRetry] = useState(0);
  const [focused, setFocused] = useState<SecureField | null>(null);
  const [errors, setErrors] = useState<Partial<Record<SecureField, string>>>({});
  const nodes = useRef<Partial<Record<SecureField, HTMLDivElement | null>>>({});
  const elements = useRef<Partial<Record<SecureField, ProviderElement>>>({});
  const complete = useRef<Partial<Record<SecureField, boolean>>>({});
  const confirm = useRef<(() => Promise<ProviderCardPreparation>) | null>(null);
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };
  const countries = useMemo(() => {
    const names = new Intl.DisplayNames([locale], { type: 'region' });
    return countryCodes
      .map((value) => ({ value, label: names.of(value) ?? value }))
      .sort((a, b) => a.label.localeCompare(b.label, locale));
  }, [locale]);
  const fieldStyle = useMemo(
    () => ({
      base: {
        fontFamily: fontFamilies.sans,
        fontSize: `${Math.max(16, TYPE_SCALE['body-regular'].fontSize)}px`,
        color: colors.text,
        '::placeholder': { color: colors.textSecondary },
      },
      invalid: { color: colors.error },
    }),
    [colors.text, colors.textSecondary, colors.error],
  );
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const styleRef = useRef(fieldStyle);
  styleRef.current = fieldStyle;
  useEffect(() => {
    for (const field of fields) elements.current[field]?.update?.({ style: fieldStyle, disabled });
  }, [fieldStyle, disabled]);
  const publish = () =>
    callbacks.current.onReady(
      !disabled &&
        matchingCardAction(actionRef.current, publishableKey) &&
        fields.every((field) => complete.current[field]) &&
        billingRef.current.country &&
        (!requirePostalCode || billingRef.current.postcode.trim())
        ? confirm.current
        : null,
    );
  const publishRef = useRef(publish);
  publishRef.current = publish;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Billing completeness updates the published callback without remounting secure fields.
  useEffect(() => {
    publishRef.current();
  }, [billing, requirePostalCode, disabled, action, publishableKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry recreates provider-owned fields for this same intent.
  useEffect(() => {
    let active = true;
    let busy = false;
    const ready = new Set<SecureField>();
    complete.current = {};
    confirm.current = null;
    callbacks.current.onReady(null);
    setPhase('loading');
    setErrors({});
    const fail = () => {
      if (!active) return;
      active = false;
      clearTimeout(timeout);
      for (const field of fields) elements.current[field]?.destroy();
      elements.current = {};
      confirm.current = null;
      callbacks.current.onReady(null);
      callbacks.current.onError?.(unavailableLabel);
      setPhase('unavailable');
    };
    const timeout = setTimeout(fail, 20000);
    if (typeof document === 'undefined' || !publishableKey) {
      fail();
      return;
    }
    void loadProviderSdk()
      .then((factory) => {
        if (!active) return;
        const provider = factory(publishableKey, {
          locale: locale.startsWith('es') ? 'es' : locale.startsWith('en') ? 'en' : 'auto',
        });
        if (!provider.confirmCardPayment || !provider.createPaymentMethod) {
          fail();
          return;
        }
        const group = provider.elements({});
        for (const field of fields) {
          const node = nodes.current[field];
          if (!node) {
            fail();
            return;
          }
          const element = group.create(providerTypes[field], {
            ...(field === 'number' ? { disableLink: true } : {}),
            style: styleRef.current,
            disabled: disabledRef.current,
          });
          elements.current[field] = element;
          element.on?.('ready', () => {
            if (!active) return;
            ready.add(field);
            if (ready.size === fields.length) {
              clearTimeout(timeout);
              setPhase('ready');
            }
          });
          element.on?.('loaderror', fail);
          element.on?.('focus', () => {
            if (active) setFocused(field);
          });
          element.on?.('blur', () => {
            if (active) setFocused((current) => (current === field ? null : current));
          });
          element.on?.('change', (event) => {
            if (!active) return;
            complete.current[field] = event?.complete === true;
            setErrors((current) => ({ ...current, [field]: event?.error?.message }));
            publishRef.current();
          });
          element.mount(node);
        }
        const tokenProvider = {
          createPaymentMethod: provider.createPaymentMethod.bind(provider),
          confirmCardPayment: provider.confirmCardPayment.bind(provider),
        };
        confirm.current = async () => {
          const card = elements.current.number;
          const authority = matchingCardAction(actionRef.current, publishableKey);
          if (!active || busy || !card || !authority || disabledRef.current)
            return { prepared: false, error: checkoutMessage(locale, 'provider.busy') };
          busy = true;
          try {
            const result = await prepareCardAuthorization({
              provider: tokenProvider,
              card,
              billing: billingRef.current,
              clientSecret: authority.value,
              returnUrl,
              messages: {
                busy: checkoutMessage(locale, 'provider.busy'),
                closed: checkoutMessage(locale, 'provider.closed'),
                incomplete: checkoutMessage(locale, 'provider.incomplete'),
                failed: checkoutMessage(locale, 'provider.failed'),
              },
            });
            if (!active || actionRef.current?.value !== authority.value) {
              if (result.prepared) result.authorization.dispose();
              return { prepared: false, error: checkoutMessage(locale, 'provider.closed') };
            }
            if (!result.prepared) return result;
            const authorization = result.authorization;
            return {
              prepared: true,
              authorization: {
                card: authorization.card,
                dispose: () => authorization.dispose(),
                confirm: () => {
                  const current = matchingCardAction(actionRef.current, publishableKey);
                  if (current?.value !== authority.value) {
                    authorization.dispose();
                    return Promise.resolve({
                      accepted: false,
                      error: checkoutMessage(locale, 'provider.closed'),
                    });
                  }
                  return authorization.confirm();
                },
              },
            };
          } catch {
            return { prepared: false, error: checkoutMessage(locale, 'provider.failed') };
          } finally {
            busy = false;
          }
        };
        publishRef.current();
      })
      .catch(fail);
    return () => {
      active = false;
      clearTimeout(timeout);
      callbacks.current.onReady(null);
      confirm.current = null;
      for (const field of fields) elements.current[field]?.destroy();
      elements.current = {};
      complete.current = {};
    };
  }, [publishableKey, locale, returnUrl, retry, unavailableLabel]);
  const label = (field: SecureField | 'country' | 'postcode') =>
    checkoutMessage(locale, `provider.card.${field}`);
  if (typeof document === 'undefined')
    return <Text accessibilityRole="alert">{unavailableLabel}</Text>;
  const hostedField = (field: SecureField) => (
    <CardFormHostedField
      label={label(field)}
      error={errors[field]}
      focused={focused === field}
      required
      disabled={disabled}
    >
      {(control) =>
        createElement('div', {
          id: control.nativeID,
          'aria-label': control.accessibilityLabel,
          'aria-describedby': control.describedBy,
          ref: (node: HTMLDivElement | null) => {
            nodes.current[field] = node;
          },
          'data-testid': `peable-secure-${field}`,
          style: { width: '100%' },
        })
      }
    </CardFormHostedField>
  );
  return (
    <>
      {phase === 'loading' && <Text>{loadingLabel}</Text>}
      {phase === 'unavailable' && (
        <>
          <Text accessibilityRole="alert">{unavailableLabel}</Text>
          <Button onPress={() => setRetry((value) => value + 1)}>
            {checkoutMessage(locale, 'provider.retry')}
          </Button>
        </>
      )}
      <CardForm
        value={billing}
        onValueChange={({ country, postcode }) => setBilling({ country, postcode })}
        fields={{ name: false, country: true, postcode: true }}
        countries={countries}
        labels={{ country: label('country'), postcode: label('postcode') }}
        disabled={disabled}
        hostedFields={{
          number: hostedField('number'),
          expiry: hostedField('expiry'),
          securityCode: hostedField('securityCode'),
        }}
      />
    </>
  );
}
