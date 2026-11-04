import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
// The `/tax` subpath, not the root: the root barrel also exports the
// node:crypto webhook signer, which a browser or native bundle cannot load.
import {
  TAX_REGISTRATION_SCHEMES,
  type TaxCode,
  type TaxRegistration,
  type TaxRegistrationScheme,
  type TaxReport,
  type TaxSettings,
} from '@peable.to/shared-types/tax';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { formatSignedAmount } from '@/format/money';
import { formatInstant, nowSeconds } from '@/format/time';
import { t } from '@/i18n';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { Choice } from '@/ui/Choice';
import { FormField } from '@/ui/FormField';
import { Section } from '@/ui/OrbitScreen';
import { PageSkeleton } from '../ui/states';

const upper = (value: string) => value.trim().toUpperCase();
const firstOfMonth = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Peable Tax for an application's owner: the seller's head office, where it is
 * registered, product tax codes, the approval that turns collection on, and the
 * filing report. Registering with a government stays the seller's job; this
 * records it. Ported from the wallet's `app/tax.tsx` onto the same routes; the
 * organization, application and Test / Live choice now come from Orbit's shell.
 *
 * This is the ONLY place collection is turned on (ADR 0011): the compliance
 * sections beside it (ADR 0020) record and assess, and never reach these routes.
 */
export function CollectionSettings({ scope }: { scope: DashboardScope }) {
  const [settings, setSettings] = useState<TaxSettings | null>(null);
  const [registrations, setRegistrations] = useState<TaxRegistration[]>([]);
  const [codes, setCodes] = useState<TaxCode[]>([]);
  const [legalName, setLegalName] = useState('');
  const [country, setCountry] = useState('');
  const [state, setState] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [defaultTaxCode, setDefaultTaxCode] = useState('');
  const [regCountry, setRegCountry] = useState('');
  const [regState, setRegState] = useState('');
  const [regScheme, setRegScheme] = useState<TaxRegistrationScheme>('standard');
  const [regNumber, setRegNumber] = useState('');
  const [productRef, setProductRef] = useState('');
  const [productCode, setProductCode] = useState('');
  const [reportFrom, setReportFrom] = useState(firstOfMonth);
  const [reportTo, setReportTo] = useState(today);
  const [report, setReport] = useState<TaxReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // Every change here is a Peable Tax decision (`money`); the filing report is a read.
  const { can } = useDashboardPermissions();
  const locked = busy || !can('money');
  const [error, setError] = useState('');
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const [loaded, regs, list] = await Promise.all([
        dashboardApi.tax.settings(scope),
        dashboardApi.tax.registrations(scope),
        dashboardApi.tax.codes(scope),
      ]);
      if (current !== generation.current) return;
      setSettings(loaded);
      setRegistrations(regs.data);
      setCodes(list.data);
      setLegalName(loaded.legal_name ?? '');
      setCountry(loaded.head_office?.country ?? '');
      setState(loaded.head_office?.state ?? '');
      setPostalCode(loaded.head_office?.postal_code ?? '');
      setDefaultTaxCode(loaded.default_tax_code);
    } catch (e) {
      if (current === generation.current) setError(describeError(e, t('tax.error')));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(describeError(e, t('tax.error')));
    } finally {
      setBusy(false);
    }
  }

  const codeOptions = codes.map((code) => ({ value: code.id, label: code.name }));
  const pending = registrations.filter((row) => row.status === 'pending_approval').length;

  if (loading && !settings)
    return <PageSkeleton variant="form" accessibilityLabel={t('tax.heading')} />;

  return (
    <View className="gap-6">
      {error ? (
        <Admonition type="error">
          <AdmonitionText>{error}</AdmonitionText>
        </Admonition>
      ) : null}
      {settings ? (
        <>
          <Section>
            <View className="flex-row flex-wrap items-center gap-2">
              <Badge
                appearance="subtle"
                tone={settings.status === 'active' ? 'success' : 'warning'}
                size="label-small"
                content={settings.status === 'active' ? t('tax.badgeActive') : t('tax.badgeDraft')}
              />
              <Text variant="body-2-semibold">
                {settings.status === 'active' ? t('tax.statusActive') : t('tax.statusDraft')}
              </Text>
            </View>
            <Text variant="body-2-regular" className="text-muted-foreground">
              {settings.provider
                ? t('tax.provider', { provider: settings.provider })
                : t('tax.noProvider')}
            </Text>
            {settings.approved_at ? (
              <Text variant="body-2-regular" className="text-muted-foreground">
                {t('tax.approvedAt', { at: formatInstant(settings.approved_at) })}
              </Text>
            ) : null}
          </Section>

          <Section title={t('tax.seller')}>
            <FormField
              label={t('tax.legalName')}
              value={legalName}
              onChange={setLegalName}
              autoCapitalize="words"
              disabled={locked}
            />
            <View className="flex-row flex-wrap gap-4">
              <View className="flex-1 min-w-48">
                <FormField
                  label={t('tax.headOfficeCountry')}
                  value={country}
                  onChange={setCountry}
                  placeholder="US"
                  autoCapitalize="characters"
                  disabled={locked}
                />
              </View>
              <View className="flex-1 min-w-48">
                <FormField
                  label={t('tax.headOfficeState')}
                  value={state}
                  onChange={setState}
                  placeholder="DE"
                  autoCapitalize="characters"
                  disabled={locked}
                />
              </View>
              <View className="flex-1 min-w-48">
                <FormField
                  label={t('tax.postalCode')}
                  value={postalCode}
                  onChange={setPostalCode}
                  autoCapitalize="characters"
                  disabled={locked}
                />
              </View>
            </View>
            <Choice
              label={t('tax.defaultCode')}
              value={defaultTaxCode || null}
              options={codeOptions}
              onChange={setDefaultTaxCode}
              disabled={locked}
            />
            <View className="flex-row justify-end">
              <Button
                appearance="solid"
                tone="accent"
                loading={busy}
                disabled={locked}
                onPress={() =>
                  void run(async () => {
                    setSettings(
                      await dashboardApi.tax.updateSettings(scope, {
                        legal_name: legalName.trim() || null,
                        head_office: upper(country)
                          ? {
                              country: upper(country),
                              state: upper(state) || null,
                              postal_code: postalCode.trim() || null,
                            }
                          : null,
                        default_tax_code: defaultTaxCode,
                      }),
                    );
                  })
                }
              >
                {t('tax.save')}
              </Button>
            </View>
          </Section>

          <Section title={t('tax.registrations')} description={t('tax.registrationsHelp')}>
            {registrations.map((row) => (
              <View
                key={row.id}
                className="flex-row flex-wrap items-center justify-between gap-2 py-3 border-b border-border"
              >
                <View className="gap-0.5 flex-1 min-w-56">
                  <Text variant="body-2-semibold" selectable>
                    {row.country}
                    {row.state ? `-${row.state}` : ''} · {t(`tax.scheme.${row.scheme}`)}
                  </Text>
                  <Text variant="caption-1-regular" className="text-muted-foreground">
                    {t(`tax.registration.${row.status}`)}
                    {row.registration_number ? ` · ${row.registration_number}` : ''}
                  </Text>
                </View>
                {row.status === 'pending_approval' ? (
                  <Button
                    appearance="outline"
                    size="sm"
                    disabled={locked}
                    onPress={() =>
                      void run(async () => {
                        await dashboardApi.tax.deleteRegistration(scope, row.id);
                        await load();
                      })
                    }
                  >
                    {t('tax.remove')}
                  </Button>
                ) : null}
                {row.status === 'active' || row.status === 'scheduled' ? (
                  <Button
                    appearance="outline"
                    tone="danger"
                    size="sm"
                    disabled={locked}
                    onPress={() =>
                      void run(async () => {
                        await dashboardApi.tax.endRegistration(scope, row.id, nowSeconds());
                        await load();
                      })
                    }
                  >
                    {t('tax.end')}
                  </Button>
                ) : null}
              </View>
            ))}
            <View className="flex-row flex-wrap gap-4">
              <View className="flex-1 min-w-40">
                <FormField
                  label={t('tax.country')}
                  value={regCountry}
                  onChange={setRegCountry}
                  placeholder="IE"
                  autoCapitalize="characters"
                  disabled={locked}
                />
              </View>
              <View className="flex-1 min-w-40">
                <FormField
                  label={t('tax.state')}
                  value={regState}
                  onChange={setRegState}
                  placeholder="NY"
                  autoCapitalize="characters"
                  disabled={locked}
                />
              </View>
              <View className="flex-1 min-w-56">
                <Choice
                  label={t('tax.scheme')}
                  value={regScheme}
                  options={TAX_REGISTRATION_SCHEMES.map((scheme) => ({
                    value: scheme,
                    label: t(`tax.scheme.${scheme}`),
                  }))}
                  onChange={(value) => setRegScheme(value as TaxRegistrationScheme)}
                  disabled={locked}
                />
              </View>
            </View>
            <FormField
              label={t('tax.registrationNumber')}
              value={regNumber}
              onChange={setRegNumber}
              disabled={locked}
            />
            <View className="flex-row justify-end">
              <Button
                appearance="outline"
                disabled={locked || !upper(regCountry)}
                onPress={() =>
                  void run(async () => {
                    await dashboardApi.tax.addRegistration(scope, {
                      country: upper(regCountry),
                      state: upper(regState) || null,
                      scheme: regScheme,
                      registration_number: regNumber.trim() || null,
                    });
                    setRegCountry('');
                    setRegState('');
                    setRegNumber('');
                    await load();
                  })
                }
              >
                {t('tax.addRegistration')}
              </Button>
            </View>
          </Section>

          <Section title={t('tax.products')} description={t('tax.productsHelp')}>
            <View className="flex-row flex-wrap gap-4">
              <View className="flex-1 min-w-56">
                <FormField
                  label={t('tax.productRef')}
                  value={productRef}
                  onChange={setProductRef}
                  disabled={locked}
                />
              </View>
              <View className="flex-1 min-w-56">
                <Choice
                  label={t('tax.productCode')}
                  value={productCode || null}
                  options={codeOptions}
                  onChange={setProductCode}
                  disabled={locked}
                />
              </View>
            </View>
            <View className="flex-row justify-end">
              <Button
                appearance="outline"
                disabled={locked || !productRef.trim() || !productCode}
                onPress={() =>
                  void run(async () => {
                    await dashboardApi.tax.setProductCode(scope, productRef.trim(), productCode);
                    setProductRef('');
                  })
                }
              >
                {t('tax.setProductCode')}
              </Button>
            </View>
          </Section>

          <Section title={t('tax.approve')} description={t('tax.approveHelp', { count: pending })}>
            <View className="flex-row justify-end">
              <Button
                appearance="solid"
                tone="accent"
                disabled={locked || (settings.status === 'active' && pending === 0)}
                onPress={() =>
                  void run(async () => {
                    const result = await dashboardApi.tax.approve(scope);
                    setSettings(result.settings);
                    setRegistrations(result.registrations);
                  })
                }
              >
                {t('tax.approveButton')}
              </Button>
            </View>
          </Section>

          <Section title={t('tax.report')}>
            <View className="flex-row flex-wrap gap-4 items-end">
              <View className="flex-1 min-w-40">
                <FormField
                  label={t('tax.from')}
                  value={reportFrom}
                  onChange={setReportFrom}
                  placeholder="2026-10-01"
                  disabled={busy}
                />
              </View>
              <View className="flex-1 min-w-40">
                <FormField
                  label={t('tax.to')}
                  value={reportTo}
                  onChange={setReportTo}
                  placeholder="2026-10-31"
                  disabled={busy}
                />
              </View>
              <Button
                appearance="outline"
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    // The last day is included: the range ends at the next UTC midnight.
                    const from = Date.parse(`${reportFrom}T00:00:00Z`) / 1000;
                    const to = Date.parse(`${reportTo}T00:00:00Z`) / 1000 + 86_400;
                    setReport(await dashboardApi.tax.report(scope, from, to));
                  })
                }
              >
                {t('tax.runReport')}
              </Button>
            </View>
            {report && !report.rows.length ? (
              <Text variant="body-2-regular" className="text-muted-foreground">
                {t('tax.reportEmpty')}
              </Text>
            ) : null}
            {report?.rows.map((row) => (
              <View
                key={`${row.country}-${row.state}-${row.registration_id}-${row.rate_percentage}-${row.currency}-${row.collection}`}
                className="py-3 border-b border-border gap-0.5"
              >
                <Text variant="body-2-semibold" selectable>
                  {row.country}
                  {row.state ? `-${row.state}` : ''} · {row.collection}
                  {row.rate_percentage ? ` · ${row.rate_percentage}%` : ''} · {row.transactions}
                </Text>
                <Text variant="caption-1-regular" selectable className="text-muted-foreground">
                  {t('tax.reportAmounts', {
                    taxable: formatSignedAmount(row.taxable_amount, row.currency),
                    tax: formatSignedAmount(row.tax_amount, row.currency),
                  })}
                </Text>
              </View>
            ))}
          </Section>
        </>
      ) : null}
    </View>
  );
}
