import type {
  BillingRailList,
  BillingRailOffer,
  BillingRailOption,
  BillingRailSettlement,
} from '@peable.to/shared-types';
import { BillingError, type BillingOwner } from './contracts';
import type { BillingService } from './billingService';

/** The provider objects a rail mints and must later be routed back to. */
export type BillingRailObjectKind = 'customer' | 'subscription' | 'checkout';

/**
 * One configured settlement rail: a complete `BillingService` plus what the
 * router needs to send it its own requests. A fiat provider (Stripe today) and
 * FairCoin are both rails; adding another provider is one more `BillingRail`,
 * never a branch in a route.
 *
 * A rail is found again from the object a request names. A rail whose
 * provider ids are opaque (Stripe's `cus_…`/`sub_…`, which predate rails and
 * cannot be renamed under live subscribers) leaves `refPatterns` unset and is
 * the catch-all. Every other rail mints NAMESPACED references and declares
 * their exact pattern, so at most one opaque rail can exist and no reference is
 * ever claimed by two rails.
 */
export interface BillingRail {
  readonly id: string;
  readonly settlement: BillingRailSettlement;
  readonly renewal: BillingRailOption['renewal'];
  readonly service: BillingService;
  readonly refPatterns?: Readonly<Record<BillingRailObjectKind, RegExp>>;
  /** Whether this rail is configured for the authenticated merchant at all. */
  serves(owner: BillingOwner): boolean;
  taxQuotes(owner: BillingOwner): boolean;
  /** Offers this rail sells for the merchant; `null` when the app binds its own provider prices. */
  offers(owner: BillingOwner): BillingRailOffer[] | null;
}

/** Routes every billing operation to exactly one rail. Rails are listed in
 * preference order: a request that names no rail and no existing object goes
 * to the first rail serving the merchant, which keeps every caller written
 * before rails existed on the rail it always used. */
export function createMultiRailBillingService(rails: readonly BillingRail[]): BillingService {
  if (rails.length < 1) throw new Error('Billing requires at least one rail');
  const ids = new Set(rails.map((rail) => rail.id));
  if (ids.size !== rails.length) throw new Error('Billing rails must be distinct');
  if (rails.filter((rail) => !rail.refPatterns).length > 1)
    throw new Error('At most one billing rail may use opaque provider references');

  const serving = (owner: BillingOwner) => {
    const found = rails.filter((rail) => rail.serves(owner));
    if (!found.length) throw new BillingError('not_found', 404);
    return found;
  };
  /** Explicit choice, else the merchant's default. */
  function choose(owner: BillingOwner, requested?: string, pick?: (rail: BillingRail) => boolean) {
    const candidates = serving(owner);
    if (requested !== undefined) {
      const rail = candidates.find((candidate) => candidate.id === requested);
      if (!rail || (pick && !pick(rail))) throw new BillingError('rail_unavailable', 404);
      return rail;
    }
    const rail = pick ? candidates.find(pick) : candidates[0];
    if (!rail) throw new BillingError('not_found', 404);
    return rail;
  }
  /** The rail that minted `ref`. A namespaced claim wins; the opaque rail takes the rest. */
  function owning(
    owner: BillingOwner,
    kind: BillingRailObjectKind,
    ref: string,
    asserted?: string,
  ) {
    const candidates = serving(owner);
    const rail =
      candidates.find((candidate) => candidate.refPatterns?.[kind].test(ref)) ??
      (rails.some((other) => other.refPatterns?.[kind].test(ref))
        ? undefined
        : candidates.find((candidate) => !candidate.refPatterns));
    if (!rail) throw new BillingError('not_found', 404);
    // A caller naming a rail must name the one its object belongs to; it can
    // never move an existing customer or subscription to another rail.
    if (asserted !== undefined && asserted !== rail.id) throw new BillingError('identity_conflict');
    return rail;
  }
  const strip = <T extends { rail?: string }>(input: T): Omit<T, 'rail'> => {
    const { rail: _rail, ...rest } = input;
    return rest;
  };

  const service: BillingService = {
    ensureCustomer: async (owner, params, key) =>
      choose(owner, params.rail).service.ensureCustomer(owner, strip(params), key),
    createTaxQuote: async (owner, params) =>
      choose(owner, params.rail, (rail) => rail.taxQuotes(owner)).service.createTaxQuote(
        owner,
        strip(params),
      ),
    createCheckoutSession: async (owner, params, key) =>
      owning(
        owner,
        'customer',
        params.providerCustomerId,
        params.rail,
      ).service.createCheckoutSession(owner, strip(params), key),
    async renew(owner, ref, params, key) {
      const rail = owning(owner, 'subscription', ref, params.rail);
      if (owning(owner, 'customer', params.providerCustomerId).id !== rail.id)
        throw new BillingError('identity_conflict');
      if (!rail.service.renew) throw new BillingError('not_found', 404);
      return rail.service.renew(owner, ref, strip(params), key);
    },
    createPortalSession: async (owner, params, key) =>
      owning(owner, 'customer', params.providerCustomerId).service.createPortalSession(
        owner,
        params,
        key,
      ),
    retrieveCheckoutOperation: async (owner, params) =>
      owning(owner, 'customer', params.providerCustomerId).service.retrieveCheckoutOperation(
        owner,
        params,
      ),
    retrieveCheckout: async (owner, ref) =>
      owning(owner, 'checkout', ref).service.retrieveCheckout(owner, ref),
    retrieveSubscription: async (owner, ref) =>
      owning(owner, 'subscription', ref).service.retrieveSubscription(owner, ref),
    retrievePaidInvoice: async (owner, ref, invoice) =>
      owning(owner, 'subscription', ref).service.retrievePaidInvoice(owner, ref, invoice),
    retrieveInvoiceState: async (owner, ref, invoice) =>
      owning(owner, 'subscription', ref).service.retrieveInvoiceState(owner, ref, invoice),
    retrieveFinalInvoiceAuthority: async (owner, ref, invoice, include) =>
      owning(owner, 'subscription', ref).service.retrieveFinalInvoiceAuthority(
        owner,
        ref,
        invoice,
        include,
      ),
    cancelAtPeriodEnd: async (owner, ref, key) =>
      owning(owner, 'subscription', ref).service.cancelAtPeriodEnd(owner, ref, key),
    async listRails(owner): Promise<BillingRailList> {
      return {
        object: 'list',
        data: serving(owner).map((rail, index) => ({
          rail: rail.id,
          settlement: rail.settlement,
          default: index === 0,
          taxQuotes: rail.taxQuotes(owner),
          renewal: rail.renewal,
          offers: rail.offers(owner),
        })),
      };
    },
  };
  return service;
}
