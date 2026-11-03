/**
 * The words of Orbit's Connect, Developers › Events and Logs, Team,
 * Business details and language screens, in English and Spanish. Merged into
 * the catalogs in `i18n.ts`; `i18n.test.ts` checks both spell the same keys
 * with the same placeholders.
 */

export const ORBIT_EN: Readonly<Record<string, string>> = {
  // Permissions (the gateway's map, `src/scope/permissions.ts`)
  'permission.change':
    'You can view this page. Changing it needs the {permission} permission on the application — ask an owner in Oxy Console.',
  'permission.view':
    'Seeing this page needs the {permission} permission on the application — ask an owner in Oxy Console.',

  'nav.connect': 'Connect',

  // Connect
  'connect.title': 'Connect',
  'connect.description':
    'The sellers your marketplace pays, their onboarding, and the settlements paid to them. Your own account is on the Account page.',
  'connect.seller': 'Seller',
  'connect.sellers': 'Sellers',
  'connect.sellersIntro':
    'Each seller is one account with up to two rails: a card account at the provider, settled by transfer, and a FairCoin key the seller registers themselves.',
  'connect.sellers.empty.title': 'No sellers',
  'connect.sellers.empty.body': 'Sellers you open in this mode appear here.',
  'connect.column.seller': 'Seller',
  'connect.column.status': 'Status',
  'connect.column.rails': 'Rails',
  'connect.column.id': 'Account',
  'connect.column.created': 'Opened',
  'connect.readiness.ready': 'Ready',
  'connect.readiness.pending': 'Onboarding',
  'connect.readiness.restricted': 'Restricted',
  'connect.rail.card': 'Card',
  'connect.rail.faircoin': 'FairCoin',
  'connect.add.externalRef': 'Your reference for the seller',
  'connect.add.externalRefHelp':
    'Your own id for them, such as a store id. Opening the same reference again returns the same seller.',
  'connect.add.card': 'Card account',
  'connect.add.country': 'Country (ISO code)',
  'connect.add.countryHelp': 'Where the seller’s business is registered. It cannot change later.',
  'connect.add.businessType': 'Business type',
  'connect.add.faircoin': 'FairCoin',
  'connect.add.oxyUserId': 'Seller’s Oxy user id',
  'connect.add.oxyUserIdHelp':
    'The only person who may register the seller’s watch-only key. Peable never takes a key from the marketplace.',
  'connect.add.submit': 'Open seller',
  'connect.add.done': 'Seller {ref} is open.',
  'connect.add.invalid.externalRef': 'Enter a reference of at most 255 characters.',
  'connect.add.invalid.rail': 'Choose a card account, FairCoin, or both.',
  'connect.add.invalid.country': 'Enter a two-letter country code, such as ES.',
  'connect.add.invalid.oxyUserId': 'Enter the seller’s Oxy user id.',
  'connect.notFound': 'No seller with this id in this mode.',
  'connect.refresh': 'Refresh from provider',
  'connect.refreshed': 'Seller refreshed.',
  'connect.field.id': 'Account ID',
  'connect.field.externalRef': 'Your reference',
  'connect.field.payable': 'Can receive transfers',
  'connect.field.faircoinStatus': 'Key',
  'connect.field.oxyUser': 'Oxy user',
  'connect.field.registered': 'Key registered',
  'connect.faircoin': 'FairCoin',
  'connect.faircoinIntro':
    'Payments on behalf of this seller go to addresses of their own watch-only key. Peable never sees or holds it for the marketplace.',
  'connect.faircoinStatus.pending': 'Waiting for the seller',
  'connect.faircoinStatus.active': 'Registered',
  'connect.requirementsIntro':
    'What the provider still needs from the seller, by requirement — never the values themselves.',
  'connect.onboarding': 'Onboarding',
  'connect.onboarding.help':
    'Make a link and send it to the seller. Links expire quickly and are not stored: make a new one whenever needed.',
  'connect.onboarding.card': 'Card onboarding link',
  'connect.onboarding.cardHelp':
    'The provider’s hosted page, where the seller completes their account.',
  'connect.onboarding.faircoin': 'FairCoin key link',
  'connect.onboarding.faircoinHelp':
    'Peable’s page where the seller, signed in to Oxy, registers their own watch-only key.',
  'connect.onboarding.nothing': 'Nothing to onboard: the FairCoin key is registered.',
  'connect.link.expires': 'Expires {at}',
  'connect.link.copied': 'Link copied.',
  'connect.transfers': 'Transfers',
  'connect.transfersIntro':
    'Settlements paid to sellers out of funded payments, newest first. An amount is never computed by Peable: it is what you asked to transfer.',
  'connect.transfers.empty.title': 'No transfers',
  'connect.transfers.empty.body': 'Settlements paid to sellers in this mode appear here.',
  'connect.transferStatus.pending': 'Pending',
  'connect.transferStatus.paid': 'Paid',
  'connect.transferStatus.partially_reversed': 'Partly reversed',
  'connect.transferStatus.reversed': 'Reversed',
  'connect.transferStatus.failed': 'Failed',
  'connect.transfer.reversed': '{amount} reversed',
  'connect.transfer.show': 'Reversals',
  'connect.transfer.hide': 'Hide',
  'connect.reversals': 'Reversals',
  'connect.reversals.none': 'Nothing has been reversed.',
  'connect.reversalStatus.pending': 'Pending',
  'connect.reversalStatus.succeeded': 'Succeeded',
  'connect.reversalStatus.failed': 'Failed',
  'connect.reverse.amount': 'Amount to reverse ({currency})',
  'connect.reverse.help': 'At most {amount} is left to reverse.',
  'connect.reverse.invalid.amount': 'Enter a positive amount with at most {decimals} decimals.',
  'connect.reverse.invalid.exceeds': 'That is more than is left to reverse.',
  'connect.reverse.submit': 'Reverse',
  'connect.reverse.retry': 'Retry the same reversal',
  'connect.reverse.discard': 'Discard',
  'connect.reverse.pending':
    'A reversal of {amount} was sent and no answer arrived. Retrying sends the same reversal: it cannot happen twice.',
  'connect.reverse.done': '{amount} reversed.',

  // Developers › Events and Logs
  'developers.view.webhooks': 'Webhooks',
  'developers.view.events': 'Events',
  'developers.view.logs': 'Logs',
  'developers.filter': 'Filter',
  'developers.events.type': 'Event type',
  'developers.events.typeHelp': 'An exact type, or a prefix ending in .* — empty for every event.',
  'developers.events.typeInvalid':
    'An event type is lowercase words joined by dots, like payment_intent.succeeded.',
  'developers.logs': 'Request logs',
  'developers.logsIntro':
    'Every API request your integration made in this mode in the last 30 days: method, path, status and duration. Bodies, headers and query strings are never kept.',
  'developers.logs.request': 'Request',
  'developers.logs.status': 'Status',
  'developers.logs.method': 'Method',
  'developers.logs.allStatuses': 'All statuses',
  'developers.logs.allMethods': 'All methods',
  'developers.logs.empty.title': 'No requests',
  'developers.logs.empty.body': 'Requests your integration makes in this mode appear here.',
  'developers.logDetail.details': 'Request',
  'developers.logDetail.intro':
    'Its id is the Request-Id the gateway answered with — the one to quote to support.',
  'developers.logDetail.id': 'Request ID',
  'developers.logDetail.path': 'Path',
  'developers.logDetail.duration': 'Duration',
  'developers.logDetail.idempotencyKey': 'Idempotency key',
  'developers.logDetail.none': 'None',
  'developers.logDetail.created': 'Answered',
  'developers.logDetail.notFound': 'No request with this id',
  'developers.logDetail.notFoundHelp':
    'Requests are kept for 30 days, and only your own integration’s are shown.',
  'developers.eventDetail.details': 'Details',
  'developers.eventDetail.id': 'Event ID',
  'developers.eventDetail.created': 'Created',
  'developers.eventDetail.apiVersion': 'API version',
  'developers.eventDetail.account': 'Connected account',
  'developers.eventDetail.request': 'Caused by request',
  'developers.eventDetail.noRequest': 'No API request: Peable made this change itself.',
  'developers.eventDetail.object': 'Object',
  'developers.eventDetail.previous': 'Previous values',
  'developers.eventDetail.previousHelp': 'The fields this change moved, as they were before it.',
  'developers.eventDetail.noDeliveries': 'No endpoint listens for this event.',
  'developers.eventDetail.notFound': 'No event with this id',

  // Payment › Events
  'payment.events': 'Events',
  'payment.eventsNote':
    'What happened to this payment in the last 30 days, each linked to the API request that caused it.',
  'payment.events.none': 'No events for this payment in the last 30 days.',
  'payment.events.noRequest': 'No request',

  // Settings › more
  'settings.more': 'Business, team and language',
  'settings.business.open': 'Business details',
  'settings.team.open': 'Team',
  'settings.back': 'Settings',

  // Business details
  'business.title': 'Business details',
  'business.description':
    'How your business appears to customers and on statements: kept by the provider on your payments account.',
  'business.profile': 'Business profile',
  'business.descriptors': 'Statement descriptors',
  'business.descriptorsIntro':
    'What customers see on their card statement, and what you see on your bank statement for a payout: 5 to 22 characters, none of < > \\ \' " *.',
  'business.field.name': 'Business name',
  'business.field.url': 'Website',
  'business.field.supportEmail': 'Support email',
  'business.field.supportUrl': 'Support page',
  'business.field.productDescription': 'What you sell',
  'business.field.mcc': 'Merchant category code',
  'business.field.statementDescriptor': 'Card statement descriptor',
  'business.field.payoutDescriptor': 'Payout statement descriptor',
  'business.invalid': 'This value is not valid here.',
  'business.cannotClear': 'This can be changed, but not removed.',
  'business.save': 'Save business details',
  'business.saved': 'Business details saved.',
  'business.nothingChanged': 'Nothing changed.',

  // Team
  'team.title': 'Team',
  'team.description':
    'Who can use Orbit for this application: the members of the Oxy organization that owns it, and what each may do in Peable.',
  'team.members': 'Members',
  'team.readOnly':
    'Members, roles and permissions are managed in Oxy Console; Orbit reads the same permissions Peable checks.',
  'team.console': 'Manage members in Oxy Console',
  'team.column.member': 'Member',
  'team.column.role': 'Role',
  'team.column.orbit': 'Orbit',
  'team.column.taxRead': 'View Peable Tax',
  'team.column.taxManage': 'Manage Peable Tax',
  'team.yes': 'Yes',
  'team.no': 'No',
  'team.inherited': 'From {account}',
  'team.inheritedParent': 'From a parent organization',
  'team.invited': 'Invited',
  'team.you': 'You',
  'team.empty': 'No members to show.',
  'team.forbidden.title': 'You cannot see this organization’s members',
  'team.forbidden.body':
    'Seeing the member list needs the members:read permission in this organization. Ask an owner or admin, or open Oxy Console.',
  'team.noApplication': 'Choose an application to see its team.',
  'team.permissions': 'What each permission allows',
  'team.permission.orbit':
    'Orbit: see every screen here — payments, payouts, Connect, reports, webhooks, settings. Granted by apps:read. Changing a screen needs its own permission on the application (app:update, webhooks:update or billing:manage).',
  'team.permission.taxRead':
    'View Peable Tax: settings, registrations and filing reports. billing:read.',
  'team.permission.taxManage':
    'Manage Peable Tax: change settings and registrations, and approve them. billing:manage.',
  'team.role.owner': 'Owner',
  'team.role.admin': 'Admin',
  'team.role.editor': 'Editor',
  'team.role.developer': 'Developer',
  'team.role.billing': 'Billing',
  'team.role.viewer': 'Viewer',

  // Language
  'language.title': 'Language',
  'language.intro':
    'Orbit follows your Oxy account’s language, shared by every Oxy app. Changing it here changes it there too.',
  'language.label': 'Language',
  'language.en': 'English',
  'language.es': 'Español',
  'language.saved': 'Language changed.',
};

export const ORBIT_ES: Readonly<Record<string, string>> = {
  'permission.change':
    'Puedes ver esta página. Cambiarla requiere el permiso {permission} en la aplicación; pídeselo a un propietario en Oxy Console.',
  'permission.view':
    'Ver esta página requiere el permiso {permission} en la aplicación; pídeselo a un propietario en Oxy Console.',

  'nav.connect': 'Connect',

  'connect.title': 'Connect',
  'connect.description':
    'Los vendedores a los que paga tu marketplace, su alta y los traspasos que reciben. Tu propia cuenta está en la página Cuenta.',
  'connect.seller': 'Vendedor',
  'connect.sellers': 'Vendedores',
  'connect.sellersIntro':
    'Cada vendedor es una cuenta con hasta dos vías: una cuenta de tarjetas en el proveedor, que se liquida por traspaso, y una clave FairCoin que registra el propio vendedor.',
  'connect.sellers.empty.title': 'No hay vendedores',
  'connect.sellers.empty.body': 'Aquí aparecen los vendedores que abras en este modo.',
  'connect.column.seller': 'Vendedor',
  'connect.column.status': 'Estado',
  'connect.column.rails': 'Vías',
  'connect.column.id': 'Cuenta',
  'connect.column.created': 'Abierta',
  'connect.readiness.ready': 'Lista',
  'connect.readiness.pending': 'En alta',
  'connect.readiness.restricted': 'Restringida',
  'connect.rail.card': 'Tarjeta',
  'connect.rail.faircoin': 'FairCoin',
  'connect.add.externalRef': 'Tu referencia del vendedor',
  'connect.add.externalRefHelp':
    'Tu propio identificador, como el de una tienda. Abrir de nuevo la misma referencia devuelve el mismo vendedor.',
  'connect.add.card': 'Cuenta de tarjetas',
  'connect.add.country': 'País (código ISO)',
  'connect.add.countryHelp':
    'Donde está registrada la empresa del vendedor. No se puede cambiar después.',
  'connect.add.businessType': 'Tipo de empresa',
  'connect.add.faircoin': 'FairCoin',
  'connect.add.oxyUserId': 'Id de usuario de Oxy del vendedor',
  'connect.add.oxyUserIdHelp':
    'La única persona que puede registrar la clave de solo lectura del vendedor. Peable nunca acepta una clave del marketplace.',
  'connect.add.submit': 'Abrir vendedor',
  'connect.add.done': 'El vendedor {ref} está abierto.',
  'connect.add.invalid.externalRef': 'Escribe una referencia de 255 caracteres como máximo.',
  'connect.add.invalid.rail': 'Elige cuenta de tarjetas, FairCoin o ambas.',
  'connect.add.invalid.country': 'Escribe un código de país de dos letras, como ES.',
  'connect.add.invalid.oxyUserId': 'Escribe el id de usuario de Oxy del vendedor.',
  'connect.notFound': 'No hay ningún vendedor con este id en este modo.',
  'connect.refresh': 'Actualizar desde el proveedor',
  'connect.refreshed': 'Vendedor actualizado.',
  'connect.field.id': 'ID de cuenta',
  'connect.field.externalRef': 'Tu referencia',
  'connect.field.payable': 'Puede recibir traspasos',
  'connect.field.faircoinStatus': 'Clave',
  'connect.field.oxyUser': 'Usuario de Oxy',
  'connect.field.registered': 'Clave registrada',
  'connect.faircoin': 'FairCoin',
  'connect.faircoinIntro':
    'Los pagos en nombre de este vendedor van a direcciones de su propia clave de solo lectura. Peable nunca la ve ni la guarda para el marketplace.',
  'connect.faircoinStatus.pending': 'Esperando al vendedor',
  'connect.faircoinStatus.active': 'Registrada',
  'connect.requirementsIntro':
    'Lo que el proveedor aún necesita del vendedor, por requisito — nunca los valores.',
  'connect.onboarding': 'Alta',
  'connect.onboarding.help':
    'Crea un enlace y envíaselo al vendedor. Los enlaces caducan pronto y no se guardan: crea uno nuevo cuando haga falta.',
  'connect.onboarding.card': 'Enlace de alta de tarjetas',
  'connect.onboarding.cardHelp':
    'La página alojada del proveedor, donde el vendedor completa su cuenta.',
  'connect.onboarding.faircoin': 'Enlace de clave FairCoin',
  'connect.onboarding.faircoinHelp':
    'La página de Peable donde el vendedor, con su sesión de Oxy, registra su propia clave de solo lectura.',
  'connect.onboarding.nothing': 'Nada que dar de alta: la clave FairCoin está registrada.',
  'connect.link.expires': 'Caduca {at}',
  'connect.link.copied': 'Enlace copiado.',
  'connect.transfers': 'Traspasos',
  'connect.transfersIntro':
    'Liquidaciones pagadas a vendedores con pagos cobrados, de la más reciente a la más antigua. Peable nunca calcula el importe: es el que pediste traspasar.',
  'connect.transfers.empty.title': 'No hay traspasos',
  'connect.transfers.empty.body':
    'Aquí aparecen las liquidaciones pagadas a vendedores en este modo.',
  'connect.transferStatus.pending': 'Pendiente',
  'connect.transferStatus.paid': 'Pagado',
  'connect.transferStatus.partially_reversed': 'Revertido en parte',
  'connect.transferStatus.reversed': 'Revertido',
  'connect.transferStatus.failed': 'Fallido',
  'connect.transfer.reversed': '{amount} revertido',
  'connect.transfer.show': 'Reversiones',
  'connect.transfer.hide': 'Ocultar',
  'connect.reversals': 'Reversiones',
  'connect.reversals.none': 'No se ha revertido nada.',
  'connect.reversalStatus.pending': 'Pendiente',
  'connect.reversalStatus.succeeded': 'Completada',
  'connect.reversalStatus.failed': 'Fallida',
  'connect.reverse.amount': 'Importe a revertir ({currency})',
  'connect.reverse.help': 'Quedan como máximo {amount} por revertir.',
  'connect.reverse.invalid.amount':
    'Escribe un importe positivo con {decimals} decimales como máximo.',
  'connect.reverse.invalid.exceeds': 'Es más de lo que queda por revertir.',
  'connect.reverse.submit': 'Revertir',
  'connect.reverse.retry': 'Reintentar la misma reversión',
  'connect.reverse.discard': 'Descartar',
  'connect.reverse.pending':
    'Se envió una reversión de {amount} y no llegó respuesta. Reintentar envía la misma reversión: no puede ocurrir dos veces.',
  'connect.reverse.done': '{amount} revertido.',

  'developers.view.webhooks': 'Webhooks',
  'developers.view.events': 'Eventos',
  'developers.view.logs': 'Registros',
  'developers.filter': 'Filtrar',
  'developers.events.type': 'Tipo de evento',
  'developers.events.typeHelp':
    'Un tipo exacto, o un prefijo acabado en .* — vacío para todos los eventos.',
  'developers.events.typeInvalid':
    'Un tipo de evento son palabras en minúscula unidas por puntos, como payment_intent.succeeded.',
  'developers.logs': 'Registro de peticiones',
  'developers.logsIntro':
    'Cada petición a la API que hizo tu integración en este modo en los últimos 30 días: método, ruta, estado y duración. Nunca se guardan cuerpos, cabeceras ni parámetros de consulta.',
  'developers.logs.request': 'Petición',
  'developers.logs.status': 'Estado',
  'developers.logs.method': 'Método',
  'developers.logs.allStatuses': 'Todos los estados',
  'developers.logs.allMethods': 'Todos los métodos',
  'developers.logs.empty.title': 'No hay peticiones',
  'developers.logs.empty.body':
    'Aquí aparecen las peticiones que hace tu integración en este modo.',
  'developers.logDetail.details': 'Petición',
  'developers.logDetail.intro':
    'Su id es el Request-Id con el que respondió la pasarela — el que hay que indicar a soporte.',
  'developers.logDetail.id': 'ID de petición',
  'developers.logDetail.path': 'Ruta',
  'developers.logDetail.duration': 'Duración',
  'developers.logDetail.idempotencyKey': 'Clave de idempotencia',
  'developers.logDetail.none': 'Ninguna',
  'developers.logDetail.created': 'Respondida',
  'developers.logDetail.notFound': 'No hay ninguna petición con este id',
  'developers.logDetail.notFoundHelp':
    'Las peticiones se guardan 30 días, y solo se muestran las de tu propia integración.',
  'developers.eventDetail.details': 'Detalles',
  'developers.eventDetail.id': 'ID del evento',
  'developers.eventDetail.created': 'Creado',
  'developers.eventDetail.apiVersion': 'Versión de la API',
  'developers.eventDetail.account': 'Cuenta conectada',
  'developers.eventDetail.request': 'Causado por la petición',
  'developers.eventDetail.noRequest':
    'Ninguna petición a la API: Peable hizo este cambio por sí mismo.',
  'developers.eventDetail.object': 'Objeto',
  'developers.eventDetail.previous': 'Valores anteriores',
  'developers.eventDetail.previousHelp':
    'Los campos que movió este cambio, tal como estaban antes.',
  'developers.eventDetail.noDeliveries': 'Ningún endpoint escucha este evento.',
  'developers.eventDetail.notFound': 'No hay ningún evento con este id',

  'payment.events': 'Eventos',
  'payment.eventsNote':
    'Lo que le ocurrió a este pago en los últimos 30 días, cada cosa enlazada a la petición a la API que la causó.',
  'payment.events.none': 'No hay eventos de este pago en los últimos 30 días.',
  'payment.events.noRequest': 'Sin petición',

  'settings.more': 'Empresa, equipo e idioma',
  'settings.business.open': 'Datos de la empresa',
  'settings.team.open': 'Equipo',
  'settings.back': 'Ajustes',

  'business.title': 'Datos de la empresa',
  'business.description':
    'Cómo aparece tu empresa ante los clientes y en los extractos: lo guarda el proveedor en tu cuenta de pagos.',
  'business.profile': 'Perfil de la empresa',
  'business.descriptors': 'Descriptores de extracto',
  'business.descriptorsIntro':
    'Lo que ven los clientes en el extracto de su tarjeta, y lo que ves tú en tu extracto bancario por una transferencia: de 5 a 22 caracteres, sin < > \\ \' " *.',
  'business.field.name': 'Nombre de la empresa',
  'business.field.url': 'Sitio web',
  'business.field.supportEmail': 'Correo de soporte',
  'business.field.supportUrl': 'Página de soporte',
  'business.field.productDescription': 'Qué vendes',
  'business.field.mcc': 'Código de categoría del comercio',
  'business.field.statementDescriptor': 'Descriptor en el extracto de tarjeta',
  'business.field.payoutDescriptor': 'Descriptor en el extracto de transferencias',
  'business.invalid': 'Este valor no es válido aquí.',
  'business.cannotClear': 'Se puede cambiar, pero no quitar.',
  'business.save': 'Guardar datos de la empresa',
  'business.saved': 'Datos de la empresa guardados.',
  'business.nothingChanged': 'No ha cambiado nada.',

  'team.title': 'Equipo',
  'team.description':
    'Quién puede usar Orbit con esta aplicación: los miembros de la organización de Oxy propietaria, y lo que cada uno puede hacer en Peable.',
  'team.members': 'Miembros',
  'team.readOnly':
    'Los miembros, roles y permisos se gestionan en Oxy Console; Orbit lee los mismos permisos que comprueba Peable.',
  'team.console': 'Gestionar miembros en Oxy Console',
  'team.column.member': 'Miembro',
  'team.column.role': 'Rol',
  'team.column.orbit': 'Orbit',
  'team.column.taxRead': 'Ver Peable Tax',
  'team.column.taxManage': 'Gestionar Peable Tax',
  'team.yes': 'Sí',
  'team.no': 'No',
  'team.inherited': 'De {account}',
  'team.inheritedParent': 'De una organización superior',
  'team.invited': 'Invitado',
  'team.you': 'Tú',
  'team.empty': 'No hay miembros que mostrar.',
  'team.forbidden.title': 'No puedes ver los miembros de esta organización',
  'team.forbidden.body':
    'Ver la lista de miembros requiere el permiso members:read en esta organización. Pídeselo a un propietario o administrador, o abre Oxy Console.',
  'team.noApplication': 'Elige una aplicación para ver su equipo.',
  'team.permissions': 'Qué permite cada permiso',
  'team.permission.orbit':
    'Orbit: ver todas las pantallas — pagos, transferencias, Connect, informes, webhooks, ajustes. Lo concede apps:read. Cambiar una pantalla requiere su propio permiso en la aplicación (app:update, webhooks:update o billing:manage).',
  'team.permission.taxRead':
    'Ver Peable Tax: ajustes, registros e informes de declaración. billing:read.',
  'team.permission.taxManage':
    'Gestionar Peable Tax: cambiar ajustes y registros, y aprobarlos. billing:manage.',
  'team.role.owner': 'Propietario',
  'team.role.admin': 'Administrador',
  'team.role.editor': 'Editor',
  'team.role.developer': 'Desarrollador',
  'team.role.billing': 'Facturación',
  'team.role.viewer': 'Lector',

  'language.title': 'Idioma',
  'language.intro':
    'Orbit sigue el idioma de tu cuenta de Oxy, compartido por todas las apps de Oxy. Cambiarlo aquí también lo cambia allí.',
  'language.label': 'Idioma',
  'language.en': 'English',
  'language.es': 'Español',
  'language.saved': 'Idioma cambiado.',
};
