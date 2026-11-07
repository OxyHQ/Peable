/**
 * Orbit's navigation registry: every destination the sidebar, the command
 * palette and the breadcrumbs know about, in ONE list. Pure — no React, no
 * Bloom — so the rules below are tested without a renderer.
 *
 * Adding a screen is one entry here (and its glyph in `icons.ts`, which the
 * compiler demands: `ORBIT_ICONS` is keyed by `OrbitDestinationKey`). An entry
 * names a route that EXISTS: `destinations.test.ts` fails when an entry points
 * at no route under `app/(orbit)`, and when a top-level route has no entry.
 *
 * The information architecture is the Stripe Dashboard's:
 *
 * - `main`     the always-visible rows (also the icons of a collapsed rail):
 *              Home, Balances, Transactions, Customers, Product catalog
 * - `products` the "Products" section: Payments (Disputes, Payment Links),
 *              Billing (Subscriptions, Invoices, settings and features),
 *              Connect, Reports, Tax, Contributions
 * - `business` the merchant's own account and how it presents itself
 * - `footer`   pinned to the sidebar's foot: Developers, Settings
 *
 * A `parent` nests an entry under a group of its section; a group with no
 * entries is not drawn, so a group can be declared before its screens land.
 *
 * Pages reached from inside a destination (Settings → Team / Business details,
 * Developers → an event or a request log) are not entries: their route lies
 * under the destination's, so they light it up and their breadcrumb leads
 * back to it.
 */

export type OrbitDestinationKey =
  | 'home'
  | 'balances'
  | 'payouts'
  | 'payments'
  | 'customers'
  | 'products'
  | 'disputes'
  | 'links'
  | 'subscriptions'
  | 'invoices'
  | 'quotes'
  | 'billing-settings'
  | 'connect'
  | 'reports'
  | 'tax'
  | 'tax-business'
  | 'tax-registrations'
  | 'tax-documents'
  | 'tax-review'
  | 'tax-deadlines'
  | 'tax-history'
  | 'tax-collection'
  | 'contributions'
  | 'account'
  | 'branding'
  | 'developers'
  | 'settings';

export type OrbitNavSection = 'main' | 'products' | 'business' | 'footer';

/** Tree sections, in the order the sidebar draws them. */
export const ORBIT_TREE_SECTIONS = ['products', 'business'] as const;
export type OrbitTreeSection = (typeof ORBIT_TREE_SECTIONS)[number];

export type OrbitNavGroupKey = 'payments-group' | 'billing' | 'tax-group';

export interface OrbitNavGroup {
  key: OrbitNavGroupKey;
  labelKey: string;
  section: OrbitTreeSection;
}

export interface OrbitDestination {
  key: OrbitDestinationKey;
  /** The `i18n` key of its label (also the page title it is known by in the palette). */
  labelKey: string;
  /** The route: `/` or `/<segment>`. Deeper paths under it (a detail, `new`) belong to it. */
  href: string;
  section: OrbitNavSection;
  /** A group of a tree section to nest under. Only tree sections have groups. */
  parent?: OrbitNavGroupKey;
  /** Command-palette synonyms (English, never shown). */
  keywords?: readonly string[];
}

export const ORBIT_NAV_GROUPS: readonly OrbitNavGroup[] = [
  { key: 'payments-group', labelKey: 'shell.group.payments', section: 'products' },
  { key: 'billing', labelKey: 'shell.group.billing', section: 'products' },
  // The Tax workspace (ADR 0020): one page per section under `/tax`.
  { key: 'tax-group', labelKey: 'nav.tax', section: 'products' },
];

/** In sidebar order within each section. */
export const ORBIT_DESTINATIONS: readonly OrbitDestination[] = [
  { key: 'home', labelKey: 'nav.home', href: '/', section: 'main', keywords: ['overview'] },
  {
    key: 'balances',
    labelKey: 'nav.balances',
    href: '/balances',
    section: 'main',
    keywords: ['money', 'available', 'pending', 'ledger'],
  },
  {
    key: 'payouts',
    labelKey: 'nav.payouts',
    href: '/payouts',
    section: 'main',
    keywords: ['transfers', 'bank', 'withdraw'],
  },
  {
    key: 'payments',
    labelKey: 'nav.payments',
    href: '/payments',
    section: 'main',
    keywords: ['transactions', 'charges', 'payment intents'],
  },
  {
    key: 'customers',
    labelKey: 'nav.customers',
    href: '/customers',
    section: 'main',
    keywords: ['payers', 'buyers', 'clients', 'balance'],
  },
  {
    key: 'products',
    labelKey: 'shell.nav.catalog',
    href: '/products',
    section: 'main',
    keywords: ['products', 'prices', 'catalog'],
  },
  {
    key: 'disputes',
    labelKey: 'nav.disputes',
    href: '/disputes',
    section: 'products',
    parent: 'payments-group',
    keywords: ['chargebacks', 'evidence'],
  },
  {
    key: 'links',
    labelKey: 'nav.links',
    href: '/links',
    section: 'products',
    parent: 'payments-group',
    keywords: ['checkout', 'share', 'url'],
  },
  {
    key: 'subscriptions',
    labelKey: 'nav.subscriptions',
    href: '/subscriptions',
    section: 'products',
    parent: 'billing',
    keywords: ['recurring', 'plans', 'renewals'],
  },
  {
    key: 'invoices',
    labelKey: 'nav.invoices',
    href: '/invoices',
    section: 'products',
    parent: 'billing',
    keywords: ['bills', 'credit notes', 'pdf'],
  },
  {
    key: 'quotes',
    labelKey: 'nav.quotes',
    href: '/quotes',
    section: 'products',
    parent: 'billing',
    keywords: ['estimates', 'proposals', 'offers', 'quotations'],
  },
  {
    key: 'billing-settings',
    labelKey: 'shell.nav.billingSettings',
    href: '/billing',
    section: 'products',
    parent: 'billing',
    keywords: ['dunning', 'retries', 'features', 'entitlements', 'customer emails'],
  },
  {
    key: 'connect',
    labelKey: 'nav.connect',
    href: '/connect',
    section: 'products',
    keywords: ['connected accounts', 'sellers', 'marketplace', 'platform', 'transfers'],
  },
  {
    key: 'reports',
    labelKey: 'nav.reports',
    href: '/reports',
    section: 'products',
    keywords: ['reporting', 'balance summary', 'reconciliation', 'export', 'csv'],
  },
  {
    key: 'tax',
    labelKey: 'compliance.nav.overview',
    href: '/tax',
    section: 'products',
    parent: 'tax-group',
    keywords: ['tax', 'vat', 'sales tax', 'assessment', 'thresholds', 'obligations'],
  },
  {
    key: 'tax-business',
    labelKey: 'compliance.nav.business',
    href: '/tax/business',
    section: 'products',
    parent: 'tax-group',
    keywords: ['tax', 'legal entity', 'operating locations', 'sales destinations', 'onboarding'],
  },
  {
    key: 'tax-registrations',
    labelKey: 'compliance.nav.registrations',
    href: '/tax/registrations',
    section: 'products',
    parent: 'tax-group',
    keywords: ['tax', 'registrations', 'authority', 'vat number', 'permit'],
  },
  {
    key: 'tax-documents',
    labelKey: 'compliance.nav.documents',
    href: '/tax/documents',
    section: 'products',
    parent: 'tax-group',
    keywords: ['tax', 'documents', 'certificate', 'checklist'],
  },
  {
    key: 'tax-review',
    labelKey: 'compliance.nav.review',
    href: '/tax/review',
    section: 'products',
    parent: 'tax-group',
    keywords: ['tax', 'review queue', 'findings', 'decisions'],
  },
  {
    key: 'tax-deadlines',
    labelKey: 'compliance.nav.deadlines',
    href: '/tax/deadlines',
    section: 'products',
    parent: 'tax-group',
    keywords: ['tax', 'deadlines', 'due dates', 'returns', 'oss'],
  },
  {
    key: 'tax-history',
    labelKey: 'compliance.nav.history',
    href: '/tax/history',
    section: 'products',
    parent: 'tax-group',
    keywords: ['tax', 'history', 'audit', 'actions'],
  },
  {
    key: 'tax-collection',
    labelKey: 'compliance.nav.collection',
    href: '/tax/collection',
    section: 'products',
    parent: 'tax-group',
    keywords: ['tax', 'collection', 'approval', 'tax settings', 'tax report', 'csv'],
  },
  {
    key: 'contributions',
    labelKey: 'nav.contributions',
    href: '/contributions',
    section: 'products',
    keywords: ['donations', 'tips'],
  },
  {
    key: 'account',
    labelKey: 'nav.account',
    href: '/account',
    section: 'business',
    keywords: ['onboarding', 'verification', 'capabilities', 'requirements'],
  },
  {
    key: 'branding',
    labelKey: 'nav.branding',
    href: '/branding',
    section: 'business',
    keywords: ['logo', 'colors', 'checkout appearance', 'emails'],
  },
  {
    key: 'developers',
    labelKey: 'nav.developers',
    href: '/developers',
    section: 'footer',
    keywords: ['webhooks', 'events', 'api', 'endpoints', 'logs', 'requests'],
  },
  {
    key: 'settings',
    labelKey: 'nav.settings',
    href: '/settings',
    section: 'footer',
    keywords: [
      'merchant',
      'payment methods',
      'domains',
      'preferences',
      'team',
      'members',
      'business details',
      'language',
    ],
  },
];

const BY_KEY = new Map(ORBIT_DESTINATIONS.map((entry) => [entry.key, entry]));

export function destination(key: OrbitDestinationKey): OrbitDestination {
  const entry = BY_KEY.get(key);
  if (!entry) throw new Error(`Unknown Orbit destination: ${key}`);
  return entry;
}

function segments(path: string): string[] {
  return path.split(/[?#]/)[0]?.split('/').filter(Boolean) ?? [];
}

/**
 * The destination a path belongs to: the entry whose href is the longest
 * segment-wise prefix of it. `/` is Home only by itself, so an unknown path
 * lights up nothing rather than Home.
 */
export function activeDestination(pathname: string): OrbitDestination | undefined {
  const path = segments(pathname);
  let best: OrbitDestination | undefined;
  let bestLength = -1;
  for (const entry of ORBIT_DESTINATIONS) {
    const href = segments(entry.href);
    if (href.length === 0) {
      if (path.length === 0 && bestLength < 0) {
        best = entry;
        bestLength = 0;
      }
      continue;
    }
    if (href.length > path.length || href.length <= bestLength) continue;
    if (href.every((segment, index) => path[index] === segment)) {
      best = entry;
      bestLength = href.length;
    }
  }
  return best;
}

export interface Crumb {
  /** An i18n key, or — for the current page — the literal title the screen gave. */
  label: string;
  href?: string;
}

/**
 * The breadcrumb trail of a page BELOW a destination (a payment's detail, a
 * new link): the destination, then the page itself. A destination's own page
 * has no trail — its title already says where you are.
 */
export function breadcrumbTrail(pathname: string, currentTitle: string): Crumb[] {
  const owner = activeDestination(pathname);
  if (!owner) return [];
  if (segments(pathname).length <= segments(owner.href).length) return [];
  return [{ label: owner.labelKey, href: owner.href }, { label: currentTitle }];
}

/** A row of the structural navigation model the shell maps onto Bloom's `Sidebar`. */
export interface NavRow {
  key: string;
  labelKey: string;
  href?: string;
  /** Rows nested under a group. */
  children?: NavRow[];
}

export interface NavSectionModel {
  key: OrbitTreeSection;
  labelKey: string;
  rows: NavRow[];
}

export interface NavModel {
  /** The always-visible rows (Bloom `items`): icons survive a collapsed rail. */
  items: NavRow[];
  /** Labelled, collapsible sections (Bloom `tree`): hidden while collapsed. */
  sections: NavSectionModel[];
  /** Pinned to the foot (Bloom `secondaryItems`). */
  footer: NavRow[];
}

const SECTION_LABELS: Record<OrbitTreeSection, string> = {
  products: 'shell.section.products',
  business: 'shell.section.business',
};

function row(entry: OrbitDestination): NavRow {
  return { key: entry.key, labelKey: entry.labelKey, href: entry.href };
}

/**
 * The sidebar's content. Expanded, it is Stripe's: the main rows, then the
 * labelled sections with their groups. A collapsed rail cannot draw sections
 * (Bloom hides the tree while collapsed), so there every destination is an
 * icon row, in the same order, and nothing becomes unreachable.
 */
export function navModel(
  options: { collapsed: boolean },
  destinations: readonly OrbitDestination[] = ORBIT_DESTINATIONS,
  groups: readonly OrbitNavGroup[] = ORBIT_NAV_GROUPS,
): NavModel {
  const main = destinations.filter((entry) => entry.section === 'main');
  const footer = destinations.filter((entry) => entry.section === 'footer').map(row);
  const treeEntries = ORBIT_TREE_SECTIONS.flatMap((section) =>
    destinations.filter((entry) => entry.section === section),
  );
  if (options.collapsed) {
    return { items: [...main, ...treeEntries].map(row), sections: [], footer };
  }
  const sections: NavSectionModel[] = [];
  for (const section of ORBIT_TREE_SECTIONS) {
    const rows: NavRow[] = [];
    const placed = new Set<OrbitNavGroupKey>();
    for (const entry of destinations) {
      if (entry.section !== section) continue;
      if (!entry.parent) {
        rows.push(row(entry));
        continue;
      }
      // A group takes the place of its first entry, and holds all of them.
      if (placed.has(entry.parent)) continue;
      placed.add(entry.parent);
      const group = groups.find((candidate) => candidate.key === entry.parent);
      const children = destinations.filter((other) => other.parent === entry.parent).map(row);
      rows.push({ key: entry.parent, labelKey: group?.labelKey ?? entry.parent, children });
    }
    if (rows.length) sections.push({ key: section, labelKey: SECTION_LABELS[section], rows });
  }
  return { items: main.map(row), sections, footer };
}

/** The group a destination sits in, so the shell opens it while one of its pages is shown. */
export function groupOf(key: string | undefined): OrbitNavGroupKey | undefined {
  if (!key) return undefined;
  return BY_KEY.get(key as OrbitDestinationKey)?.parent;
}
