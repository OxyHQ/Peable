import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { catalogFor } from '../i18n';
import {
  activeDestination,
  breadcrumbTrail,
  groupOf,
  navModel,
  ORBIT_DESTINATIONS,
  ORBIT_NAV_GROUPS,
  type OrbitDestination,
} from './destinations';

const ROUTES = join(import.meta.dir, '../../app/(orbit)');

/** The top-level routes of the signed-in group: `payments/`, `tax.tsx`, `index.tsx` → ``. */
function topLevelRoutes(): string[] {
  return readdirSync(ROUTES, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('_') && !entry.name.startsWith('+'))
    .map((entry) => (entry.isDirectory() ? entry.name : entry.name.replace(/\.tsx?$/, '')))
    .map((name) => (name === 'index' ? '' : name));
}

describe('the registry and the routes', () => {
  it('points every destination at a route that exists', () => {
    for (const entry of ORBIT_DESTINATIONS) {
      const segment = entry.href.replace(/^\//, '');
      const exists =
        segment === ''
          ? existsSync(join(ROUTES, 'index.tsx'))
          : existsSync(join(ROUTES, `${segment}.tsx`)) ||
            existsSync(join(ROUTES, segment, 'index.tsx'));
      expect({ key: entry.key, exists }).toEqual({ key: entry.key, exists: true });
    }
  });

  it('lists every top-level route, so a new screen is never unreachable', () => {
    const hrefs = new Set(ORBIT_DESTINATIONS.map((entry) => entry.href.replace(/^\//, '')));
    for (const route of topLevelRoutes())
      expect({ route, listed: hrefs.has(route) }).toEqual({
        route,
        listed: true,
      });
  });

  it('has unique keys and hrefs', () => {
    const keys = ORBIT_DESTINATIONS.map((entry) => entry.key);
    const hrefs = ORBIT_DESTINATIONS.map((entry) => entry.href);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('names every label in the English catalog, and Spanish has nothing English lacks', () => {
    const en = catalogFor('en') ?? {};
    const labels = [
      ...ORBIT_DESTINATIONS.map((entry) => entry.labelKey),
      ...ORBIT_NAV_GROUPS.map((group) => group.labelKey),
    ];
    for (const key of labels)
      expect({ key, known: Object.hasOwn(en, key) }).toEqual({
        key,
        known: true,
      });
  });

  it('nests only under a declared group of the same section', () => {
    for (const entry of ORBIT_DESTINATIONS) {
      if (!entry.parent) continue;
      const group = ORBIT_NAV_GROUPS.find((candidate) => candidate.key === entry.parent);
      expect(group?.section).toBe(entry.section as never);
    }
  });
});

describe('activeDestination', () => {
  it('is Home only at the root', () => {
    expect(activeDestination('/')?.key).toBe('home');
    expect(activeDestination('/nowhere')).toBeUndefined();
  });

  it('owns the pages below a destination', () => {
    expect(activeDestination('/payments')?.key).toBe('payments');
    expect(activeDestination('/payments/pi_123')?.key).toBe('payments');
    expect(activeDestination('/links/new')?.key).toBe('links');
    expect(activeDestination('/products/prod_1?tab=prices')?.key).toBe('products');
  });

  it('matches whole segments, never a prefix of one', () => {
    expect(activeDestination('/paymentsx')).toBeUndefined();
    expect(activeDestination('/pay')).toBeUndefined();
  });
});

describe('breadcrumbTrail', () => {
  it('is empty on a destination itself', () => {
    expect(breadcrumbTrail('/payments', 'Payments')).toEqual([]);
    expect(breadcrumbTrail('/', 'Home')).toEqual([]);
  });

  it('leads a detail back to its destination', () => {
    expect(breadcrumbTrail('/payments/pi_1', 'Payment')).toEqual([
      { label: 'nav.payments', href: '/payments' },
      { label: 'Payment' },
    ]);
    expect(breadcrumbTrail('/links/new', 'New payment link')[0]?.href).toBe('/links');
  });
});

describe('navModel', () => {
  it('draws Stripe’s sections expanded: main rows, Products with its groups, footer', () => {
    const model = navModel({ collapsed: false });
    expect(model.items.map((row) => row.key)).toEqual([
      'home',
      'balances',
      'payouts',
      'payments',
      'customers',
      'products',
    ]);
    expect(model.sections.map((section) => section.key)).toEqual(['products', 'business']);
    const products = model.sections[0];
    expect(products?.rows.map((row) => row.key)).toEqual([
      'payments-group',
      'billing',
      'connect',
      'reports',
      'tax-group',
      'contributions',
    ]);
    expect(products?.rows[0]?.children?.map((row) => row.key)).toEqual(['disputes', 'links']);
    // The Tax workspace (ADR 0020): its overview first, collection last.
    expect(products?.rows[4]?.children?.map((row) => row.key)).toEqual([
      'tax',
      'tax-business',
      'tax-registrations',
      'tax-documents',
      'tax-review',
      'tax-deadlines',
      'tax-history',
      'tax-collection',
    ]);
    expect(products?.rows[1]?.children?.map((row) => row.key)).toEqual([
      'subscriptions',
      'invoices',
      'quotes',
      'billing-settings',
    ]);
    expect(model.footer.map((row) => row.key)).toEqual(['developers', 'settings']);
  });

  it('draws a group only while it has a screen', () => {
    const withoutBilling = ORBIT_DESTINATIONS.filter((entry) => entry.parent !== 'billing');
    const keys = navModel({ collapsed: false }, withoutBilling).sections.flatMap((section) =>
      section.rows.map((row) => row.key),
    );
    expect(keys).not.toContain('billing');
    const onlyInvoices: OrbitDestination[] = [
      ...withoutBilling,
      ...ORBIT_DESTINATIONS.filter((entry) => entry.key === 'invoices'),
    ];
    const billing = navModel({ collapsed: false }, onlyInvoices).sections[0]?.rows.find(
      (row) => row.key === 'billing',
    );
    expect(billing?.children?.map((row) => row.key)).toEqual(['invoices']);
  });

  it('keeps every destination reachable as an icon while collapsed', () => {
    const model = navModel({ collapsed: true });
    expect(model.sections).toEqual([]);
    const reachable = [...model.items, ...model.footer].map((row) => row.key).sort();
    expect(reachable).toEqual(ORBIT_DESTINATIONS.map((entry) => entry.key).sort());
  });

  it('knows which group holds a page', () => {
    expect(groupOf('disputes')).toBe('payments-group');
    expect(groupOf('invoices')).toBe('billing');
    expect(groupOf('tax')).toBe('tax-group');
    expect(groupOf('tax-review')).toBe('tax-group');
    // Each Tax page is its own destination: the sidebar lights it, no trail.
    expect(activeDestination('/tax')?.key).toBe('tax');
    expect(activeDestination('/tax/review')?.key).toBe('tax-review');
    expect(breadcrumbTrail('/tax/review', 'Review')).toEqual([]);
    expect(groupOf('reports')).toBeUndefined();
    expect(groupOf(undefined)).toBeUndefined();
  });
});

describe('pages inside a destination', () => {
  it('light up the destination and lead back to it', () => {
    expect(activeDestination('/settings/team')?.key).toBe('settings');
    expect(breadcrumbTrail('/settings/team', 'Team')[0]?.href).toBe('/settings');
    expect(activeDestination('/developers/logs/req_1')?.key).toBe('developers');
    expect(activeDestination('/billing')?.key).toBe('billing-settings');
    expect(activeDestination('/connect/acct_1')?.key).toBe('connect');
  });
});
