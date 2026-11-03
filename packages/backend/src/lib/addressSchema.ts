// TRANSITIONAL: address and shipping request schemas are contracts
// (`@peable.to/contracts` `addressParams` / `shippingParams` / `emailParam`).
// This module only re-exports them under their old names while the routes
// move to the contract imports, and is deleted once no route imports it.
export {
  addressParams as addressSchema,
  emailParam as emailSchema,
  shippingParams as shippingSchema,
  toAddress,
  toShipping,
} from '@peable.to/contracts';
