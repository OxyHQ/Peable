/**
 * The words of Orbit's global search box, in English and Spanish. Merged into
 * the catalogs in `i18n.ts`; `i18n.test.ts` checks both spell the same keys
 * with the same placeholders.
 */

export const SEARCH_EN: Readonly<Record<string, string>> = {
  'search.label': 'Search',
  'search.placeholder': 'Search payments, customers, invoices… or an id',
  'search.hint':
    "Free text matches emails, names and descriptions (3 characters or more). An id (pi_…, cus_…) opens that object. A query such as status:\"succeeded\" or metadata['order']:'42' runs on every resource that has its fields.",
  'search.searching': 'Searching',
  'search.empty': 'Nothing matches “{q}” in this mode.',
  'search.more': 'More results exist; refine the search to see them.',
  'search.group.payment_intents': 'Payments',
  'search.group.charges': 'Charges',
  'search.group.customers': 'Customers',
  'search.group.products': 'Products',
  'search.group.prices': 'Prices',
  'search.group.refunds': 'Refunds',
  'search.group.subscriptions': 'Subscriptions',
  'search.group.invoices': 'Invoices',
  'search.archived': 'Archived',
  'search.active': 'Active',
  'search.noDetail': 'No detail page in Orbit yet',
};

export const SEARCH_ES: Readonly<Record<string, string>> = {
  'search.label': 'Buscar',
  'search.placeholder': 'Busca pagos, clientes, facturas… o un id',
  'search.hint':
    "El texto libre busca en correos, nombres y descripciones (3 caracteres o más). Un id (pi_…, cus_…) abre ese objeto. Una consulta como status:\"succeeded\" o metadata['order']:'42' se ejecuta en cada recurso que tenga esos campos.",
  'search.searching': 'Buscando',
  'search.empty': 'Nada coincide con «{q}» en este modo.',
  'search.more': 'Hay más resultados; afina la búsqueda para verlos.',
  'search.group.payment_intents': 'Pagos',
  'search.group.charges': 'Cargos',
  'search.group.customers': 'Clientes',
  'search.group.products': 'Productos',
  'search.group.prices': 'Precios',
  'search.group.refunds': 'Reembolsos',
  'search.group.subscriptions': 'Suscripciones',
  'search.group.invoices': 'Facturas',
  'search.archived': 'Archivado',
  'search.active': 'Activo',
  'search.noDetail': 'Todavía sin página de detalle en Orbit',
};
