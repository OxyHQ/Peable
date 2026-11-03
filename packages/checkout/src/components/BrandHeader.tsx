import type { CheckoutBranding, MerchantDisplay } from '@peable.to/shared-types';
import { useI18n } from '../i18n';

/**
 * Who the payer is paying, in the merchant's own branding. Every URL here was
 * resolved by the gateway through Oxy's media chokepoint (a withheld file is
 * `null`); this component never builds a media URL itself.
 */
export function BrandHeader({
  merchant,
  branding,
  livemode,
}: {
  merchant: MerchantDisplay;
  branding: CheckoutBranding;
  livemode: boolean;
}) {
  const { t } = useI18n();
  const icon = branding.icon_url ?? merchant.avatar_url;
  // The wordmark is the merchant's `business_logo`, which branding resolves.
  const logo = branding.logo_url ?? merchant.logo_url;
  return (
    <header className="brand-header">
      {logo ? (
        <img className="brand-header__logo" src={logo} alt={merchant.name} />
      ) : (
        <div className="brand-header__identity">
          {icon && <img className="brand-header__icon" src={icon} alt="" />}
          <span className="brand-header__name">{merchant.name}</span>
        </div>
      )}
      {!livemode && <span className="brand-header__badge">{t('testMode')}</span>}
    </header>
  );
}
