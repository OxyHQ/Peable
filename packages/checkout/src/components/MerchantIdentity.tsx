import type { MerchantDisplay } from '@peable.to/shared-types';

// `avatarUrl` is already a fully-resolved URL — the backend resolved it
// server-side through the SDK's canonical media chokepoint. This component
// never builds a URL itself and never hardcodes a media host.
export function MerchantIdentity({ merchant }: { merchant: MerchantDisplay }) {
  return (
    <div className="merchant-identity">
      {merchant.avatar_url && (
        <img className="merchant-identity__avatar" src={merchant.avatar_url} alt="" />
      )}
      <div>
        <p className="merchant-identity__name">{merchant.name}</p>
        {merchant.description && (
          <p className="merchant-identity__description">{merchant.description}</p>
        )}
      </div>
    </div>
  );
}
