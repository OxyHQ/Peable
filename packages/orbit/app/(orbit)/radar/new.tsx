import { t } from '@/i18n';
import { RuleEditor } from '@/radar/RuleEditor';
import { OrbitScreen } from '@/ui/OrbitScreen';

/**
 * A new rule. A person without `money` still sees the editor: checking a
 * condition and testing it against recent payments are reads; only saving is
 * refused, and the page says why once.
 */
export default function NewRiskRuleScreen() {
  return (
    <OrbitScreen title={t('radar.new')} description={t('radar.newIntro')}>
      {({ scope }) => (
        <RuleEditor key={`${scope.applicationId}:${scope.environment}`} scope={scope} />
      )}
    </OrbitScreen>
  );
}
