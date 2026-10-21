import { t } from '@/i18n';
import { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView } from 'react-native';
import { Stack } from 'expo-router';
import type { AccountNode, Application } from '@oxy.so/core';
// The `/tax` subpath, not the root: the root barrel also exports the
// node:crypto webhook signer, which Metro cannot resolve on iOS/Android.
import {
  TAX_REGISTRATION_SCHEMES,
  type TaxCode,
  type TaxRegistration,
  type TaxRegistrationScheme,
  type TaxReport,
  type TaxSettings,
} from '@peable.to/shared-types/tax';
import { oxyServices } from '@/services/oxy-services';
import { taxDashboard, type TaxEnvironment } from '@/services/tax-dashboard';
import { SafeAreaView } from '@/ui/safe-area-view';

const message = (error: unknown) => (error instanceof Error ? error.message : t('tax.error'));
const upper = (value: string) => value.trim().toUpperCase();

/**
 * Peable Tax for an application's owner: the seller's head office, where it is
 * registered, product tax codes, the approval that turns collection on, and
 * the filing report. Registering with a government stays the seller's job;
 * this records it.
 */
export default function TaxScreen() {
  const [organizations, setOrganizations] = useState<AccountNode[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [applicationId, setApplicationId] = useState('');
  const [environment, setEnvironment] = useState<TaxEnvironment>('production');
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
  const [reportFrom, setReportFrom] = useState(
    new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10),
  );
  const [reportTo, setReportTo] = useState(new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState<TaxReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const scope = { applicationId, environment };

  useEffect(() => {
    let canceled = false;
    oxyServices.accounts
      .list()
      .then((rows) => {
        if (!canceled)
          setOrganizations(
            rows.filter(
              (row) =>
                row.kind === 'organization' &&
                ['owner', 'admin', 'billing'].includes(row.callerMembership?.role ?? ''),
            ),
          );
      })
      .catch((e) => !canceled && setError(message(e)));
    return () => {
      canceled = true;
    };
  }, []);
  useEffect(() => {
    let canceled = false;
    setApplicationId('');
    setApplications([]);
    if (organizationId)
      oxyServices.apps
        .list(organizationId)
        .then((rows) => !canceled && setApplications(rows.filter((app) => app.status === 'active')))
        .catch((e) => !canceled && setError(message(e)));
    return () => {
      canceled = true;
    };
  }, [organizationId]);
  async function load() {
    const current = ++generation.current;
    setSettings(null);
    setRegistrations([]);
    setReport(null);
    setError('');
    if (!applicationId) return;
    try {
      const [loaded, regs, list] = await Promise.all([
        taxDashboard.settings(scope),
        taxDashboard.registrations(scope),
        taxDashboard.codes(scope),
      ]);
      if (current !== generation.current) return;
      setSettings(loaded);
      setRegistrations(regs.data);
      setCodes(list.data);
      setLegalName(loaded.legalName ?? '');
      setCountry(loaded.headOffice?.country ?? '');
      setState(loaded.headOffice?.state ?? '');
      setPostalCode(loaded.headOffice?.postalCode ?? '');
      setDefaultTaxCode(loaded.defaultTaxCode);
    } catch (e) {
      if (current === generation.current) setError(message(e));
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload exactly when the scope changes
  useEffect(() => {
    void load();
  }, [applicationId, environment]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const button = (label: string, action: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={busy || disabled}
      onPress={action}
      className="rounded-xl bg-primary px-4 py-3 my-1"
    >
      <Text className="text-primary-foreground">{label}</Text>
    </Pressable>
  );
  const input = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    placeholder?: string,
  ) => (
    <TextInput
      accessibilityLabel={label}
      placeholder={placeholder ?? label}
      className="border border-border rounded-xl p-3 text-foreground"
      value={value}
      onChangeText={onChange}
      editable={!busy}
      autoCapitalize="characters"
    />
  );
  const pending = registrations.filter((row) => row.status === 'pending_approval').length;

  return (
    <SafeAreaView className="flex-1 bg-background">
      <Stack.Screen options={{ title: t('tax.title') }} />
      <ScrollView contentContainerClassName="p-4 gap-3 max-w-2xl w-full mx-auto pb-20">
        <Text className="text-foreground text-xl font-semibold">{t('tax.heading')}</Text>
        <Text className="text-muted-foreground">{t('tax.intro')}</Text>
        {error ? (
          <Text accessibilityRole="alert" className="text-destructive">
            {error}
          </Text>
        ) : null}
        <Text className="text-foreground font-semibold">{t('tax.organization')}</Text>
        {organizations.map((row) => (
          <View key={row.accountId}>
            {button(
              `${row.accountId === organizationId ? '✓ ' : ''}${row.account.username ?? row.accountId}`,
              () => setOrganizationId(row.accountId),
            )}
          </View>
        ))}
        {!organizations.length ? (
          <Text className="text-muted-foreground">{t('tax.signin')}</Text>
        ) : null}
        <Text className="text-foreground font-semibold">{t('tax.application')}</Text>
        {applications.map((app) => (
          <View key={app._id}>
            {button(`${app._id === applicationId ? '✓ ' : ''}${app.name}`, () =>
              setApplicationId(app._id),
            )}
          </View>
        ))}
        <View className="flex-row gap-2">
          {button(environment === 'development' ? `✓ ${t('tax.test')}` : t('tax.test'), () =>
            setEnvironment('development'),
          )}
          {button(environment === 'production' ? `✓ ${t('tax.live')}` : t('tax.live'), () =>
            setEnvironment('production'),
          )}
        </View>

        {settings && (
          <>
            <View className="border border-border rounded-xl p-3 gap-1">
              <Text className="text-foreground font-semibold">
                {settings.status === 'active' ? t('tax.statusActive') : t('tax.statusDraft')}
              </Text>
              <Text className="text-muted-foreground">
                {settings.provider
                  ? t('tax.provider', { provider: settings.provider })
                  : t('tax.noProvider')}
              </Text>
              {settings.approvedAt ? (
                <Text className="text-muted-foreground">
                  {t('tax.approvedAt', { at: settings.approvedAt })}
                </Text>
              ) : null}
            </View>

            <Text className="text-foreground text-lg font-semibold">{t('tax.seller')}</Text>
            <TextInput
              accessibilityLabel={t('tax.legalName')}
              placeholder={t('tax.legalName')}
              className="border border-border rounded-xl p-3 text-foreground"
              value={legalName}
              onChangeText={setLegalName}
              editable={!busy}
            />
            {input(t('tax.headOfficeCountry'), country, setCountry, 'US')}
            {input(t('tax.headOfficeState'), state, setState, 'DE')}
            {input(t('tax.postalCode'), postalCode, setPostalCode)}
            <Text className="text-foreground">{t('tax.defaultCode')}</Text>
            {codes.map((code) => (
              <View key={code.id}>
                {button(`${code.id === defaultTaxCode ? '✓ ' : ''}${code.name}`, () =>
                  setDefaultTaxCode(code.id),
                )}
              </View>
            ))}
            {button(
              t('tax.save'),
              () =>
                void run(async () => {
                  setSettings(
                    await taxDashboard.updateSettings(scope, {
                      legalName: legalName.trim() || null,
                      headOffice: upper(country)
                        ? {
                            country: upper(country),
                            state: upper(state) || null,
                            postalCode: postalCode.trim() || null,
                          }
                        : null,
                      defaultTaxCode,
                    }),
                  );
                }),
            )}

            <Text className="text-foreground text-lg font-semibold">{t('tax.registrations')}</Text>
            <Text className="text-muted-foreground">{t('tax.registrationsHelp')}</Text>
            {registrations.map((row) => (
              <View key={row.id} className="border border-border rounded-xl p-3 gap-1">
                <Text selectable className="text-foreground">
                  {row.country}
                  {row.state ? `-${row.state}` : ''} · {t(`tax.scheme.${row.scheme}`)} ·{' '}
                  {t(`tax.registration.${row.status}`)}
                </Text>
                {row.registrationNumber ? (
                  <Text selectable className="text-muted-foreground">
                    {row.registrationNumber}
                  </Text>
                ) : null}
                {row.status === 'pending_approval' &&
                  button(
                    t('tax.remove'),
                    () =>
                      void run(async () => {
                        await taxDashboard.deleteRegistration(scope, row.id);
                        await load();
                      }),
                  )}
                {(row.status === 'active' || row.status === 'scheduled') &&
                  button(
                    t('tax.end'),
                    () =>
                      void run(async () => {
                        await taxDashboard.endRegistration(scope, row.id, new Date().toISOString());
                        await load();
                      }),
                  )}
              </View>
            ))}
            {input(t('tax.country'), regCountry, setRegCountry, 'IE')}
            {input(t('tax.state'), regState, setRegState, 'NY')}
            <View className="flex-row flex-wrap gap-2">
              {TAX_REGISTRATION_SCHEMES.map((scheme) => (
                <View key={scheme}>
                  {button(`${scheme === regScheme ? '✓ ' : ''}${t(`tax.scheme.${scheme}`)}`, () =>
                    setRegScheme(scheme),
                  )}
                </View>
              ))}
            </View>
            {input(t('tax.registrationNumber'), regNumber, setRegNumber)}
            {button(
              t('tax.addRegistration'),
              () =>
                void run(async () => {
                  await taxDashboard.addRegistration(scope, {
                    country: upper(regCountry),
                    state: upper(regState) || null,
                    scheme: regScheme,
                    registrationNumber: regNumber.trim() || null,
                  });
                  setRegCountry('');
                  setRegState('');
                  setRegNumber('');
                  await load();
                }),
              !upper(regCountry),
            )}

            <Text className="text-foreground text-lg font-semibold">{t('tax.products')}</Text>
            <Text className="text-muted-foreground">{t('tax.productsHelp')}</Text>
            <TextInput
              accessibilityLabel={t('tax.productRef')}
              placeholder={t('tax.productRef')}
              className="border border-border rounded-xl p-3 text-foreground"
              value={productRef}
              onChangeText={setProductRef}
              editable={!busy}
              autoCapitalize="none"
            />
            {codes.map((code) => (
              <View key={code.id}>
                {button(`${code.id === productCode ? '✓ ' : ''}${code.name}`, () =>
                  setProductCode(code.id),
                )}
              </View>
            ))}
            {button(
              t('tax.setProductCode'),
              () =>
                void run(async () => {
                  await taxDashboard.setProductCode(scope, productRef.trim(), productCode);
                  setProductRef('');
                }),
              !productRef.trim() || !productCode,
            )}

            <Text className="text-foreground text-lg font-semibold">{t('tax.approve')}</Text>
            <Text className="text-muted-foreground">
              {t('tax.approveHelp', { count: pending })}
            </Text>
            {button(
              t('tax.approveButton'),
              () =>
                void run(async () => {
                  const result = await taxDashboard.approve(scope);
                  setSettings(result.settings);
                  setRegistrations(result.registrations);
                }),
              settings.status === 'active' && pending === 0,
            )}

            <Text className="text-foreground text-lg font-semibold">{t('tax.report')}</Text>
            {input(t('tax.from'), reportFrom, setReportFrom, '2026-10-01')}
            {input(t('tax.to'), reportTo, setReportTo, '2026-10-31')}
            {button(
              t('tax.runReport'),
              () =>
                void run(async () => {
                  const end = new Date(`${reportTo}T00:00:00Z`);
                  end.setUTCDate(end.getUTCDate() + 1);
                  setReport(
                    await taxDashboard.report(
                      scope,
                      new Date(`${reportFrom}T00:00:00Z`).toISOString(),
                      end.toISOString(),
                    ),
                  );
                }),
            )}
            {report && !report.rows.length ? (
              <Text className="text-muted-foreground">{t('tax.reportEmpty')}</Text>
            ) : null}
            {report?.rows.map((row) => (
              <View
                key={`${row.country}-${row.state}-${row.registrationId}-${row.ratePercentage}-${row.currency}-${row.collection}`}
                className="border border-border rounded-xl p-3"
              >
                <Text selectable className="text-foreground">
                  {row.country}
                  {row.state ? `-${row.state}` : ''} · {row.collection}
                  {row.ratePercentage ? ` · ${row.ratePercentage}%` : ''} · {row.transactions}
                </Text>
                <Text selectable className="text-muted-foreground">
                  {t('tax.reportAmounts', {
                    taxable: (row.taxableAmount / 100).toFixed(2),
                    tax: (row.taxAmount / 100).toFixed(2),
                    currency: row.currency,
                  })}
                </Text>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
