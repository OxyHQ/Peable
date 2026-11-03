import { useMutation } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import { toast } from '@oxy.so/bloom/toast';
import { describeError } from '../api/transport';
import { SUPPORTED_LOCALES, t, useLocale } from '../i18n';
import { Choice } from './Choice';
import { Section } from './OrbitScreen';

/**
 * The language switcher. It changes the language of the person's OXY account
 * (or their guest choice when signed out) — the one Oxy hands every app,
 * Orbit included, through `OxyProvider`'s `language.onChange` (Oxy ADR 0022).
 * Orbit keeps no language of its own; the screen follows once Oxy has it.
 */
const OXY_LOCALE: Readonly<Record<string, string>> = { en: 'en-US', es: 'es-ES' };

export function LanguageSettings() {
  const locale = useLocale();
  const { setLanguage } = useOxy();
  const change = useMutation({
    mutationFn: (language: string) => setLanguage(OXY_LOCALE[language] ?? language),
    onSuccess: () => toast.success(t('language.saved')),
    onError: (error) => toast.error(describeError(error, t('error.generic'))),
  });
  return (
    <Section title={t('language.title')} description={t('language.intro')}>
      <Choice
        label={t('language.label')}
        value={locale}
        options={SUPPORTED_LOCALES.map((language) => ({
          value: language,
          label: t(`language.${language}`),
        }))}
        disabled={change.isPending}
        onChange={(language) => {
          if (language !== locale) change.mutate(language);
        }}
      />
    </Section>
  );
}
