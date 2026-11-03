/**
 * Words added with the Stripe-parity pass over Orbit's tables, Home and empty
 * lists, in English and Spanish. `i18n.test.ts` keeps the two in step.
 */
export const PARITY_EN: Record<string, string> = {
  'payments.column.description': 'Description',
  'links.column.currency': 'Currency',
  'links.column.sessions': 'Completed',
  'links.empty.firstTitle': 'Sell with a link',
  'links.empty.firstBody':
    'A payment link is a hosted checkout page for one or more of your prices. Share it anywhere — no code needed — and every purchase appears in Payments.',
  'products.column.pricing': 'Default price',
  'products.column.updated': 'Updated',
  'products.empty.firstTitle': 'Add your first product',
  'products.empty.firstBody':
    'Products are what you sell — goods, services or plans. Give one a price to sell it with Checkout, a Payment Link or a subscription.',
  'list.column.customer': 'Customer',
  'list.column.email': 'Email',
  'list.column.created': 'Created',
  'list.column.status': 'Status',
  'list.column.total': 'Total',
  'list.column.number': 'Number',
  'list.column.due': 'Due',
  'list.column.product': 'Product',
  'list.column.periodEnd': 'Current period ends',
  'list.column.balance': 'Balance',
  'list.column.id': 'ID',
  'list.column.name': 'Name',
  'home.overview': 'Today',
  'home.tile.gross': 'Gross volume',
  'home.tile.grossToday': 'Gross volume · today',
  'home.tile.gross7d': 'Gross volume · last 7 days',
  'home.tile.succeededCount': '{count} successful payments',
  'home.tile.available': 'Available to pay out',
  'home.tile.pending': 'Pending',
  'home.tile.noBalance': 'No payments account in this mode',
  'home.tile.payouts': 'Payouts in transit',
  'home.tile.payoutsNone': 'None in transit',
  'home.tile.sampleNote': 'From the latest {count} payments',
  'home.tile.multiCurrency': '+ {count} more currencies',
  'home.activity': 'Recent activity',
  'payments.empty.firstTitle': 'Accept your first payment',
  'payments.empty.firstBody':
    'Payments appear here as soon as a customer pays through Checkout, a Payment Link or your integration. In test mode, use a test card or testnet FairCoin.',
  'payments.empty.createLink': 'Create a payment link',
  'customers.empty.firstTitle': 'No customers yet',
  'customers.empty.firstBody':
    'Customers keep a buyer’s details, payment methods and billing history together. They are created by Checkout, subscriptions or your integration.',
  'subscriptions.empty.firstTitle': 'No subscriptions yet',
  'subscriptions.empty.firstBody':
    'Subscriptions charge a customer on a recurring price. Add a recurring price to a product, then start a subscription from Checkout or your integration.',
  'subscriptions.empty.addProduct': 'Add a product',
  'invoices.empty.firstTitle': 'No invoices yet',
  'invoices.empty.firstBody':
    'Invoices are created for every subscription period and can be sent to customers to pay online. They appear here with their status and amount due.',
};

export const PARITY_ES: Record<string, string> = {
  'payments.column.description': 'Descripción',
  'links.column.currency': 'Divisa',
  'links.column.sessions': 'Completados',
  'links.empty.firstTitle': 'Vende con un enlace',
  'links.empty.firstBody':
    'Un enlace de pago es una página de pago alojada para uno o varios de tus precios. Compártelo donde quieras, sin código, y cada compra aparecerá en Pagos.',
  'products.column.pricing': 'Precio predeterminado',
  'products.column.updated': 'Actualizado',
  'products.empty.firstTitle': 'Añade tu primer producto',
  'products.empty.firstBody':
    'Los productos son lo que vendes: bienes, servicios o planes. Ponles un precio para venderlos con Checkout, un enlace de pago o una suscripción.',
  'list.column.customer': 'Cliente',
  'list.column.email': 'Correo electrónico',
  'list.column.created': 'Creado',
  'list.column.status': 'Estado',
  'list.column.total': 'Total',
  'list.column.number': 'Número',
  'list.column.due': 'Vencimiento',
  'list.column.product': 'Producto',
  'list.column.periodEnd': 'Fin del periodo actual',
  'list.column.balance': 'Saldo',
  'list.column.id': 'ID',
  'list.column.name': 'Nombre',
  'home.overview': 'Hoy',
  'home.tile.gross': 'Volumen bruto',
  'home.tile.grossToday': 'Volumen bruto · hoy',
  'home.tile.gross7d': 'Volumen bruto · últimos 7 días',
  'home.tile.succeededCount': '{count} pagos completados',
  'home.tile.available': 'Disponible para transferir',
  'home.tile.pending': 'Pendiente',
  'home.tile.noBalance': 'No hay cuenta de pagos en este modo',
  'home.tile.payouts': 'Transferencias en curso',
  'home.tile.payoutsNone': 'Ninguna en curso',
  'home.tile.sampleNote': 'De los últimos {count} pagos',
  'home.tile.multiCurrency': '+ {count} divisas más',
  'home.activity': 'Actividad reciente',
  'payments.empty.firstTitle': 'Acepta tu primer pago',
  'payments.empty.firstBody':
    'Los pagos aparecen aquí en cuanto un cliente paga mediante Checkout, un enlace de pago o tu integración. En modo de prueba, usa una tarjeta de prueba o FairCoin de testnet.',
  'payments.empty.createLink': 'Crear un enlace de pago',
  'customers.empty.firstTitle': 'Aún no hay clientes',
  'customers.empty.firstBody':
    'Los clientes reúnen los datos de un comprador, sus métodos de pago y su historial de facturación. Los crean Checkout, las suscripciones o tu integración.',
  'subscriptions.empty.firstTitle': 'Aún no hay suscripciones',
  'subscriptions.empty.firstBody':
    'Las suscripciones cobran a un cliente un precio recurrente. Añade un precio recurrente a un producto y empieza una suscripción desde Checkout o tu integración.',
  'subscriptions.empty.addProduct': 'Añadir un producto',
  'invoices.empty.firstTitle': 'Aún no hay facturas',
  'invoices.empty.firstBody':
    'Se crea una factura por cada periodo de suscripción y se puede enviar al cliente para que la pague en línea. Aparecen aquí con su estado y el importe pendiente.',
};
