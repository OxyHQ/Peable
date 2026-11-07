import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import type {
  VerificationCheckStatus,
  VerificationSession,
  VerificationSessionStatus,
} from '@peable.to/shared-types';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@oxy.so/bloom/table';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { describeError } from '../api/transport';
import { labelFor, t } from '../i18n';
import { RowLink, Timestamp } from '../ui/data';
import { checkStatusTone, identityRefusal, verificationStatusTone } from './identityForm';

export function verificationStatusLabel(status: VerificationSessionStatus): string {
  return labelFor('verificationStatus', status);
}

export function VerificationStatusBadge({ status }: { status: VerificationSessionStatus }) {
  return (
    <Badge
      appearance="subtle"
      tone={verificationStatusTone(status)}
      size="label-small"
      content={verificationStatusLabel(status)}
    />
  );
}

export function CheckStatusBadge({ status }: { status: VerificationCheckStatus }) {
  return (
    <Badge
      appearance="subtle"
      tone={checkStatusTone(status)}
      size="label-small"
      content={labelFor('checkStatus', status)}
    />
  );
}

/**
 * What a failed identity write says: Identity not enabled for this mode, a
 * session that moved, or the gateway's own message — never a bare failure.
 */
export function identityErrorMessage(error: unknown): string {
  switch (identityRefusal(error)) {
    case 'unavailable':
      return t('identity.unavailable');
    case 'state':
      return t('identity.state');
    case null:
      return describeError(error, t('error.generic'));
  }
}

/**
 * The person's hosted verification link: single use, 48 hours. Shown right
 * after a create and on the detail while the session waits for the person.
 */
export function HostedLink({ url, footer }: { url: string; footer?: ReactNode }) {
  return (
    <Admonition type="info">
      <View className="gap-2">
        <Text variant="body-2-semibold">{t('identity.link.title')}</Text>
        <AdmonitionText>{t('identity.link.body')}</AdmonitionText>
        <View className="flex-row flex-wrap items-center gap-2">
          <Text variant="body-2-regular" selectable className="font-mono flex-1 min-w-48">
            {url}
          </Text>
          <Button
            appearance="outline"
            size="sm"
            onPress={() =>
              void Clipboard.setStringAsync(url).then(
                () => toast.success(t('identity.link.copied')),
                () => toast.error(t('error.generic')),
              )
            }
          >
            {t('action.copy')}
          </Button>
          {footer}
        </View>
      </View>
    </Admonition>
  );
}

const COLUMNS = {
  status: { flex: 2, minWidth: 160 },
  type: { flex: 2, minWidth: 160 },
  reference: { flex: 2, minWidth: 160 },
  id: { flex: 3, minWidth: 200 },
  created: { flex: 2, minWidth: 130 },
} as const;

/** Verification sessions: status, check, your reference, id, created; a row opens it. */
export function VerificationTable({
  sessions,
  empty,
}: {
  sessions: readonly VerificationSession[];
  empty?: ReactNode;
}) {
  const router = useRouter();
  return (
    <Table accessibilityLabel={t('identity.title')} minWidth={800} size="sm">
      <TableHeader>
        <TableColumn {...COLUMNS.status}>{t('list.column.status')}</TableColumn>
        <TableColumn {...COLUMNS.type}>{t('identity.column.type')}</TableColumn>
        <TableColumn {...COLUMNS.reference}>{t('identity.column.reference')}</TableColumn>
        <TableColumn {...COLUMNS.id}>{t('verification.field.id')}</TableColumn>
        <TableColumn {...COLUMNS.created}>{t('list.column.created')}</TableColumn>
      </TableHeader>
      <TableBody emptyState={empty}>
        {sessions.map((session) => (
          <RowLink
            key={session.id}
            accessibilityLabel={`${t('verification.title')} ${session.id}`}
            onPress={() => router.push({ pathname: '/identity/[id]', params: { id: session.id } })}
          >
            <TableRow>
              <TableCell {...COLUMNS.status}>
                <VerificationStatusBadge status={session.status} />
              </TableCell>
              <TableCell {...COLUMNS.type}>
                <Text variant="body-2-regular" numberOfLines={1}>
                  {labelFor('verificationType', session.type)}
                </Text>
              </TableCell>
              <TableCell {...COLUMNS.reference}>
                <Text variant="body-2-regular" numberOfLines={1} className="font-mono">
                  {session.client_reference_id ?? '—'}
                </Text>
              </TableCell>
              <TableCell {...COLUMNS.id}>
                <Text variant="body-2-regular" numberOfLines={1} className="font-mono">
                  {session.id}
                </Text>
              </TableCell>
              <TableCell {...COLUMNS.created}>
                <Timestamp seconds={session.created} muted />
              </TableCell>
            </TableRow>
          </RowLink>
        ))}
      </TableBody>
    </Table>
  );
}
