import { useMemo } from 'react';
import { Command, type CommandItem } from '@oxy.so/bloom/command';
import { RiFlaskLine } from '@oxy.so/bloom/icons/RiFlaskLine';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { RiStore2Line } from '@oxy.so/bloom/icons/RiStore2Line';
import { t } from '../i18n';
import { environmentForMode, modeForEnvironment } from '../scope/scope';
import { useOrbitScope } from '../scope/ScopeProvider';
import { ORBIT_DESTINATIONS } from './destinations';
import { orbitIcon } from './icons';

/**
 * The command palette (⌘K / Ctrl+K): Bloom's `Command` over every destination
 * of the registry, switching Test / Live and to every other application of the
 * organization, and the way into the search over the application's objects
 * (`SearchDialog`, which is also the top bar's search and `/`).
 */
export function CommandPalette({
  open,
  onOpenChange,
  onNavigate,
  onSearch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (href: string) => void;
  /** Opens the search over the application's objects. */
  onSearch: () => void;
}) {
  const scope = useOrbitScope();
  const { applications, applicationId, environment, setApplicationId, setEnvironment } = scope;
  const items = useMemo<CommandItem[]>(() => {
    const navigate = t('shell.palette.group.navigate');
    const list: CommandItem[] = ORBIT_DESTINATIONS.map((entry) => ({
      id: `go:${entry.key}`,
      label: t(entry.labelKey),
      group: navigate,
      icon: orbitIcon(entry.key),
      keywords: [...(entry.keywords ?? []), entry.href],
      onSelect: () => onNavigate(entry.href),
    }));
    const live = modeForEnvironment(environment) === 'live';
    list.push({
      id: 'search',
      label: t('shell.palette.search'),
      group: t('shell.palette.group.actions'),
      icon: RiSearchLine,
      shortcut: '/',
      keywords: ['find', 'lookup', 'id', 'customer', 'payment', 'product'],
      onSelect: onSearch,
    });
    list.push({
      id: 'mode',
      label: t(live ? 'shell.palette.switchToTest' : 'shell.palette.switchToLive'),
      group: t('shell.palette.group.actions'),
      icon: RiFlaskLine,
      keywords: ['test', 'live', 'sandbox', 'production'],
      onSelect: () => setEnvironment(environmentForMode(live ? 'test' : 'live')),
    });
    for (const app of applications) {
      if (app._id === applicationId) continue;
      list.push({
        id: `app:${app._id}`,
        label: app.name,
        group: t('shell.palette.group.applications'),
        icon: RiStore2Line,
        keywords: ['application', 'switch'],
        onSelect: () => setApplicationId(app._id),
      });
    }
    return list;
  }, [
    applications,
    applicationId,
    environment,
    setApplicationId,
    setEnvironment,
    onNavigate,
    onSearch,
  ]);

  return (
    <Command
      open={open}
      onOpenChange={onOpenChange}
      items={items}
      placeholder={t('shell.palette.placeholder')}
      emptyText={t('shell.palette.empty')}
    />
  );
}
