import { browserLanguages, I18nProvider, queryLocale, resolveLocale, useI18n } from '../i18n';

function NotFound() {
  const { t } = useI18n();
  return (
    <main className="checkout-page">
      <p className="checkout-page__pending">{t('notFound')}</p>
    </main>
  );
}

export function NotFoundRoute() {
  return (
    <I18nProvider locale={resolveLocale({ override: queryLocale(), browser: browserLanguages() })}>
      <NotFound />
    </I18nProvider>
  );
}
