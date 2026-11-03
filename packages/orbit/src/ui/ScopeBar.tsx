import { View } from 'react-native';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { Text } from '@oxy.so/bloom/typography';
import { t } from '../i18n';
import {
  environmentForMode,
  modeForEnvironment,
  organizationLabel,
  type OrbitMode,
} from '../scope/scope';
import { useOrbitScope } from '../scope/ScopeProvider';
import { Choice } from './Choice';

/**
 * Organization, application, and the Test / Live toggle — at the top of every
 * screen, so what a merchant is looking at is never a guess.
 */
export function ScopeBar() {
  const scope = useOrbitScope();
  const mode = modeForEnvironment(scope.environment);
  return (
    <View className="flex-row flex-wrap items-end gap-3">
      <View className="flex-1 min-w-48">
        <Choice
          size="sm"
          label={t('scope.organization')}
          placeholder={t('scope.chooseOrganization')}
          value={scope.organizationId}
          disabled={!scope.organizations.length}
          options={scope.organizations.map((node) => ({
            value: node.accountId,
            label: organizationLabel(node),
          }))}
          onChange={scope.setOrganizationId}
        />
      </View>
      <View className="flex-1 min-w-48">
        <Choice
          size="sm"
          label={t('scope.application')}
          placeholder={t('scope.chooseApplication')}
          value={scope.applicationId}
          disabled={!scope.applications.length}
          options={scope.applications.map((app) => ({ value: app._id, label: app.name }))}
          onChange={scope.setApplicationId}
        />
      </View>
      <View className="gap-1.5">
        <Text variant="caption-1-medium" className="text-muted-foreground">
          {t('scope.mode')}
        </Text>
        <SegmentedControl<OrbitMode>
          label={t('scope.mode')}
          type="radio"
          size="sm"
          value={mode}
          onValueChange={(next) => scope.setEnvironment(environmentForMode(next))}
        >
          <SegmentedControlItem value="test">
            <SegmentedControlItemText>{t('scope.test')}</SegmentedControlItemText>
          </SegmentedControlItem>
          <SegmentedControlItem value="live">
            <SegmentedControlItemText>{t('scope.live')}</SegmentedControlItemText>
          </SegmentedControlItem>
        </SegmentedControl>
      </View>
    </View>
  );
}
