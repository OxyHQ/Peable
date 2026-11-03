import { useEffect, useRef } from 'react';
import { usePathname } from 'expo-router';
import { Dialog } from '@oxy.so/bloom/dialog';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { t } from '../i18n';
import { useOrbitScope } from '../scope/ScopeProvider';
import { SearchBox } from '../search/SearchBox';

/**
 * The top bar's search: Orbit's one search box (`search/SearchBox.tsx`, the
 * gateway's `…/search`) in a Bloom dialog, over the selected application and
 * mode. A result opens its object's page, and the dialog goes with the page it
 * was opened over.
 */
export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { scope } = useOrbitScope();
  const pathname = usePathname();
  const shownOn = useRef(pathname);
  useEffect(() => {
    if (shownOn.current === pathname) return;
    shownOn.current = pathname;
    onClose();
  }, [pathname, onClose]);

  return (
    <Dialog open={open} onClose={onClose} title={t('search.label')} maxWidth={640}>
      {scope ? (
        <SearchBox key={`${scope.applicationId}:${scope.environment}`} scope={scope} autoFocus />
      ) : (
        <EmptyState
          variant="compact"
          title={t('scope.noApplications.title')}
          description={t('shell.scope.choose')}
        />
      )}
    </Dialog>
  );
}
