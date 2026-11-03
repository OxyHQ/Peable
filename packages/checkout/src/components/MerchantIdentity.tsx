import type { MerchantDisplay } from '@peable.to/shared-types';

// `avatar_url` and `logo_url` are already fully-resolved URLs — the backend
// resolved them server-side through the SDK's canonical media chokepoint. This
// component never builds a URL itself and never hardcodes a media host.
//
// The avatar is the square identity image; the logo is the merchant's
// wordmark, and when there is one it stands where the name would be (its
// `alt` is the name, so the name is still what a screen reader hears).
export function MerchantIdentity({ merchant }: { merchant: MerchantDisplay }) {
  return (
    <div className="merchant-identity">
      {merchant.avatar_url && (
        <img className="merchant-identity__avatar" src={merchant.avatar_url} alt="" />
      )}
      <div>
        {merchant.logo_url ? (
          <img className="merchant-identity__logo" src={merchant.logo_url} alt={merchant.name} />
        ) : (
          <p className="merchant-identity__name">{merchant.name}</p>
        )}
        {merchant.description && (
          <p className="merchant-identity__description">{merchant.description}</p>
        )}
      </div>
    </div>
  );
}
