import { checkoutSessionRoutes } from './checkoutSessions';
import { contributionRoutes } from './contributions';
import { fileRoutes } from './files';
import { merchantRoutes } from './merchants';
import { paymentLinkRoutes } from './paymentLinks';
import { paymentMethodConfigurationRoutes } from './paymentMethodConfigurations';

export * from './checkoutSessions';
export * from './contributions';
export * from './files';
export * from './merchants';
export * from './paymentLinks';
export * from './paymentMethodConfigurations';
// The shared building blocks' public half: the sub-objects sessions and links
// return, and what a backend needs to store a parsed request. The rest of
// `./shared` (rail, locale, URL and amount params) stays internal to checkout.
export {
  type AdjustableQuantityParams,
  adjustableBoundsOf,
  type CheckoutAdjustableQuantity,
  type CheckoutAutomaticTax,
  type CheckoutBranding,
  type CheckoutConsent,
  type CheckoutConsentCollection,
  type CheckoutCustomerDetails,
  type CheckoutCustomField,
  type CheckoutCustomFieldDropdownOption,
  type CheckoutCustomFieldLabel,
  type CheckoutCustomFieldParams,
  type CheckoutDiscount,
  type CheckoutLineItem,
  type CheckoutShippingDetails,
  type CheckoutTaxId,
  type CheckoutTotalDetails,
  type MerchantDisplay,
  checkoutAdjustableQuantitySchema,
  checkoutAutomaticTaxSchema,
  checkoutBrandingSchema,
  checkoutConsentCollectionSchema,
  checkoutConsentSchema,
  checkoutCustomerDetailsSchema,
  checkoutCustomFieldSchema,
  checkoutDiscountSchema,
  checkoutLineItemSchema,
  checkoutShippingDetailsSchema,
  checkoutTaxIdSchema,
  checkoutTotalDetailsSchema,
  customFieldsParam,
  merchantDisplaySchema,
} from './shared';

/** Checkout, payment links, the merchant and its branding, files and contributions. */
export const checkoutRoutes = [
  ...checkoutSessionRoutes,
  ...paymentLinkRoutes,
  ...paymentMethodConfigurationRoutes,
  ...merchantRoutes,
  ...fileRoutes,
  ...contributionRoutes,
] as const;
