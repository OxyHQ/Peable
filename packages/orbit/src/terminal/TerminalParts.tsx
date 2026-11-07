import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type {
  TerminalLocation,
  TerminalReader,
  TerminalReaderStatus,
} from '@peable.to/shared-types';
import { Button } from '@oxy.so/bloom/button';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@oxy.so/bloom/table';
import { Text } from '@oxy.so/bloom/typography';
import { describeError } from '../api/transport';
import { labelFor, t } from '../i18n';
import { RowLink, Timestamp } from '../ui/data';
import { ToneBadge } from '../ui/StatusBadge';
import { addressLine, readerLocationId, readerStatusTone, terminalRefusal } from './terminalForm';

/**
 * What a failed Terminal write says: Terminal off in this mode, a location
 * still holding readers, a busy or offline reader, the live gate, a refused
 * registration code — or the gateway's own message. Never a bare failure.
 */
export function terminalErrorMessage(error: unknown): string {
  const refusal = terminalRefusal(error);
  if (refusal !== null) return t(`terminal.${refusal}`);
  return describeError(error, t('error.generic'));
}

export function ReaderStatusBadge({ status }: { status: TerminalReaderStatus | null }) {
  return (
    <ToneBadge
      tone={readerStatusTone(status)}
      label={status === null ? t('readerStatus.unknown') : labelFor('readerStatus', status)}
    />
  );
}

/** A reader's location as words: its name, or what Orbit knows of it. */
export function locationName(
  reader: Pick<TerminalReader, 'location'>,
  names: ReadonlyMap<string, string>,
): string {
  if (reader.location !== null && typeof reader.location === 'object') {
    return reader.location.display_name;
  }
  const id = readerLocationId(reader);
  if (id === null) return t('terminal.noLocation');
  return names.get(id) ?? t('terminal.unknownLocation', { id });
}

const READER_COLUMNS = {
  label: { flex: 3, minWidth: 180 },
  status: { flex: 2, minWidth: 120 },
  device: { flex: 2, minWidth: 160 },
  location: { flex: 3, minWidth: 180 },
  seen: { flex: 2, minWidth: 130 },
} as const;

/** Readers: label, status, device, location, last seen; a row opens the reader. */
export function ReadersTable({
  readers,
  locationNames,
  empty,
}: {
  readers: readonly TerminalReader[];
  locationNames: ReadonlyMap<string, string>;
  empty?: ReactNode;
}) {
  const router = useRouter();
  return (
    <Table accessibilityLabel={t('terminal.readers')} minWidth={800} size="sm">
      <TableHeader>
        <TableColumn {...READER_COLUMNS.label}>{t('terminal.column.label')}</TableColumn>
        <TableColumn {...READER_COLUMNS.status}>{t('list.column.status')}</TableColumn>
        <TableColumn {...READER_COLUMNS.device}>{t('terminal.column.deviceType')}</TableColumn>
        <TableColumn {...READER_COLUMNS.location}>{t('terminal.column.location')}</TableColumn>
        <TableColumn {...READER_COLUMNS.seen}>{t('terminal.column.lastSeen')}</TableColumn>
      </TableHeader>
      <TableBody emptyState={empty}>
        {readers.map((reader) => (
          <RowLink
            key={reader.id}
            accessibilityLabel={`${t('reader.title')} ${reader.label}`}
            onPress={() =>
              router.push({ pathname: '/terminal/readers/[id]', params: { id: reader.id } })
            }
          >
            <TableRow>
              <TableCell {...READER_COLUMNS.label}>
                <Text variant="body-2-medium" numberOfLines={1}>
                  {reader.label}
                </Text>
              </TableCell>
              <TableCell {...READER_COLUMNS.status}>
                <ReaderStatusBadge status={reader.status} />
              </TableCell>
              <TableCell {...READER_COLUMNS.device}>
                <Text variant="body-2-regular" numberOfLines={1} className="font-mono">
                  {reader.device_type}
                </Text>
              </TableCell>
              <TableCell {...READER_COLUMNS.location}>
                <Text variant="body-2-regular" numberOfLines={1}>
                  {locationName(reader, locationNames)}
                </Text>
              </TableCell>
              <TableCell {...READER_COLUMNS.seen}>
                <Timestamp seconds={reader.last_seen_at} muted />
              </TableCell>
            </TableRow>
          </RowLink>
        ))}
      </TableBody>
    </Table>
  );
}

const LOCATION_COLUMNS = {
  name: { flex: 3, minWidth: 180 },
  address: { flex: 5, minWidth: 260 },
  actions: { flex: 2, minWidth: 180 },
} as const;

/** Locations: name, address, and Edit / Delete for whoever may change them. */
export function LocationsTable({
  locations,
  canWrite,
  busyId,
  onEdit,
  onDelete,
  empty,
}: {
  locations: readonly TerminalLocation[];
  canWrite: boolean;
  /** The location being deleted, if any. */
  busyId: string | null;
  onEdit: (location: TerminalLocation) => void;
  onDelete: (location: TerminalLocation) => void;
  empty?: ReactNode;
}) {
  return (
    <Table accessibilityLabel={t('terminal.locations')} minWidth={680} size="sm">
      <TableHeader>
        <TableColumn {...LOCATION_COLUMNS.name}>{t('terminal.column.name')}</TableColumn>
        <TableColumn {...LOCATION_COLUMNS.address}>{t('terminal.column.address')}</TableColumn>
        <TableColumn {...LOCATION_COLUMNS.actions}>{''}</TableColumn>
      </TableHeader>
      <TableBody emptyState={empty}>
        {locations.map((location) => (
          <TableRow key={location.id}>
            <TableCell {...LOCATION_COLUMNS.name}>
              <View className="gap-0.5">
                <Text variant="body-2-medium" numberOfLines={1}>
                  {location.display_name}
                </Text>
                <Text
                  variant="caption-1-regular"
                  numberOfLines={1}
                  selectable
                  className="font-mono text-muted-foreground"
                >
                  {location.id}
                </Text>
              </View>
            </TableCell>
            <TableCell {...LOCATION_COLUMNS.address}>
              <Text variant="body-2-regular" numberOfLines={2}>
                {addressLine(location)}
              </Text>
            </TableCell>
            <TableCell {...LOCATION_COLUMNS.actions}>
              <View className="flex-row flex-wrap justify-end gap-2">
                <Button
                  appearance="outline"
                  size="sm"
                  disabled={!canWrite}
                  onPress={() => onEdit(location)}
                >
                  {t('terminal.location.edit')}
                </Button>
                <Button
                  appearance="outline"
                  tone="danger"
                  size="sm"
                  disabled={!canWrite || busyId !== null}
                  loading={busyId === location.id}
                  onPress={() => onDelete(location)}
                >
                  {t('terminal.location.delete')}
                </Button>
              </View>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
