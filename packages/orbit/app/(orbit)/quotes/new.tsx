import { Text } from '@oxy.so/bloom/typography';
import { useLocalSearchParams } from 'expo-router';
import type { DashboardScope } from '@/api/dashboard';
import { t } from '@/i18n';
import { lineOfItem, QuoteBuilder } from '@/quotes/QuoteBuilder';
import type { QuoteLineForm } from '@/quotes/quoteForm';
import { useQuote } from '@/quotes/useQuotes';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { ErrorNotice, OrbitScreen } from '@/ui/OrbitScreen';
import { isNotFound, NotFound, PageSkeleton, PermissionNotice } from '@/ui/states';

/** `?id=qt_…`: the draft, read, then edited in the same builder. */
function EditDraft({ scope, id }: { scope: DashboardScope; id: string }) {
  const query = useQuote(scope, id);
  if (query.isPending)
    return <PageSkeleton variant="detail" accessibilityLabel={t('quote.title')} />;
  if (query.isError) {
    if (isNotFound(query.error)) return <NotFound title={t('quote.notFound')} />;
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  const { quote, lines } = query.data;
  if (quote.status !== 'draft') {
    return (
      <Text variant="body-2-regular" className="text-muted-foreground">
        {t('quote.edit.notDraft')}
      </Text>
    );
  }
  const initialLines = lines.map(lineOfItem).filter((line): line is QuoteLineForm => line !== null);
  return (
    <QuoteBuilder
      key={`${quote.id}:${quote.created}`}
      scope={scope}
      quote={quote}
      initialLines={initialLines}
    />
  );
}

export default function NewQuoteScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { can } = useDashboardPermissions();
  return (
    <OrbitScreen
      title={id ? t('quote.edit.title') : t('quotes.new')}
      description={id ? t('quote.edit.intro') : t('quotes.newIntro')}
    >
      {({ scope }) =>
        !can('money') ? (
          <PermissionNotice action="money" />
        ) : id ? (
          <EditDraft scope={scope} id={id} />
        ) : (
          <QuoteBuilder key={`${scope.applicationId}:${scope.environment}`} scope={scope} />
        )
      }
    </OrbitScreen>
  );
}
