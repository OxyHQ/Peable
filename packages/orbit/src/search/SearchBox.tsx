import { type ReactNode, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { Loading } from '@oxy.so/bloom/loading';
import { Search } from '@oxy.so/bloom/search';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '../api/client';
import type { DashboardScope } from '../api/dashboard';
import { describeError } from '../api/transport';
import { t } from '../i18n';
import {
  SEARCH_DEBOUNCE_MS,
  type SearchRow,
  searchGroupTitle,
  searchRows,
  searchTerm,
} from './results';

/** `value`, once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function ResultRow({ row }: { row: SearchRow }) {
  const router = useRouter();
  const body = (
    <View className="gap-0.5 py-2">
      <Text variant="body-2-medium">{row.label}</Text>
      <Text variant="caption-1-regular" className="text-muted-foreground" selectable>
        {row.href ? row.sublabel : `${row.sublabel} · ${t('search.noDetail')}`}
      </Text>
    </View>
  );
  if (!row.href) return body;
  const href = row.href;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${row.label}, ${row.sublabel}`}
      onPress={() => router.push(href)}
      className="rounded-lg px-2 -mx-2 hover:bg-muted"
    >
      {body}
    </Pressable>
  );
}

/**
 * Orbit's one search box, over every searchable resource of the selected
 * application and mode (`GET …/search?q=`). Typing settles for a moment before
 * the gateway is asked; results are grouped by resource, newest first, at most
 * five each, and open the screen each object has.
 */
export function SearchBox({ scope }: { scope: DashboardScope }) {
  const [input, setInput] = useState('');
  const term = useDebounced(searchTerm(input), SEARCH_DEBOUNCE_MS);
  const results = useQuery({
    queryKey: ['orbit', scope.applicationId, scope.environment, 'search', term],
    queryFn: () => dashboardApi.search.global(scope, term ?? ''),
    enabled: term !== null,
    staleTime: 5_000,
  });

  let panel: ReactNode = null;
  if (term !== null) {
    if (results.isPending) {
      panel = <Loading accessibilityLabel={t('search.searching')} />;
    } else if (results.isError) {
      panel = (
        <Admonition type="error">
          <AdmonitionText>{describeError(results.error, t('error.generic'))}</AdmonitionText>
        </Admonition>
      );
    } else if (results.data.groups.length === 0) {
      panel = (
        <Text variant="body-2-regular" className="text-muted-foreground">
          {t('search.empty', { q: term })}
        </Text>
      );
    } else {
      panel = (
        <View className="gap-4">
          {results.data.groups.map((group) => (
            <View key={group.resource} className="gap-1">
              <Text variant="caption-1-medium" className="text-muted-foreground uppercase">
                {searchGroupTitle(group.resource)}
              </Text>
              {searchRows(group).map((row) => (
                <ResultRow key={row.key} row={row} />
              ))}
              {group.has_more ? (
                <Text variant="caption-1-regular" className="text-muted-foreground">
                  {t('search.more')}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      );
    }
  }

  return (
    <View className="gap-3">
      <Search
        label={t('search.label')}
        placeholder={t('search.placeholder')}
        value={input}
        onChangeText={setInput}
        onClearText={() => setInput('')}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {panel ? (
        <View className="gap-3 rounded-2xl border border-border bg-card p-4">
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {t('search.hint')}
          </Text>
          {panel}
        </View>
      ) : null}
    </View>
  );
}
