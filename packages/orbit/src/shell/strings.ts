/**
 * The shell's own words — the sidebar, the top bar, the command palette —
 * kept beside the shell (as `money/strings.ts` keeps the money screens'), so a
 * change to the chrome never touches the screens' catalog. English and
 * Spanish carry the same keys; `i18n.test.ts` holds them to it.
 */

export const SHELL_EN: Record<string, string> = {
  'shell.nav.catalog': 'Product catalog',
  'shell.nav.billingSettings': 'Settings and features',
  'shell.group.payments': 'Payments',
  'shell.group.billing': 'Billing',
  'shell.section.products': 'Products',
  'shell.section.business': 'Business',

  'shell.sidebar.label': 'Orbit navigation',
  'shell.sidebar.collapse': 'Collapse sidebar',
  'shell.sidebar.expand': 'Expand sidebar',
  'shell.sidebar.close': 'Close navigation',
  'shell.sidebar.open': 'Open navigation',

  'shell.scope.menu': 'Switch organization or application',
  'shell.scope.organizations': 'Organizations',
  'shell.scope.applications': 'Applications',
  'shell.scope.choose': 'Choose an application',
  'shell.scope.loading': 'Loading…',

  'shell.account.menu': 'Account menu',
  'shell.account.manage': 'Manage your Oxy account',
  'shell.account.signOut': 'Sign out',

  'shell.search.label': 'Search Orbit',
  'shell.search.placeholder': 'Search',
  'shell.palette.placeholder': 'Go to a page or run an action…',
  'shell.palette.empty': 'Nothing matches.',
  'shell.palette.group.navigate': 'Go to',
  'shell.palette.group.actions': 'Actions',
  'shell.palette.group.applications': 'Switch application',
  'shell.palette.switchToLive': 'Switch to live mode',
  'shell.palette.switchToTest': 'Switch to test mode',
  'shell.palette.search': 'Search payments, customers, products…',

  'shell.testMode': 'Test mode',
  'shell.testMode.hint': 'Viewing test data',
  'shell.testMode.strip': 'Test mode — you are viewing test data. Nothing here moves real money.',

  'shell.help': 'Help',
  'shell.help.title': 'Keyboard shortcuts',
  'shell.help.palette': 'Go to a page or run an action',
  'shell.help.slash': 'Search this application’s objects, when not typing in a field',
  'shell.help.sidebar': 'Collapse or expand the sidebar',
  'shell.help.close': 'Close',
  'shell.notifications': 'Notifications',

  'shell.breadcrumb': 'Breadcrumb',
  'shell.list.count': '{count} shown',
};

export const SHELL_ES: Record<string, string> = {
  'shell.nav.catalog': 'Catálogo de productos',
  'shell.nav.billingSettings': 'Ajustes y funciones',
  'shell.group.payments': 'Pagos',
  'shell.group.billing': 'Facturación',
  'shell.section.products': 'Productos',
  'shell.section.business': 'Empresa',

  'shell.sidebar.label': 'Navegación de Orbit',
  'shell.sidebar.collapse': 'Contraer la barra lateral',
  'shell.sidebar.expand': 'Expandir la barra lateral',
  'shell.sidebar.close': 'Cerrar la navegación',
  'shell.sidebar.open': 'Abrir la navegación',

  'shell.scope.menu': 'Cambiar de organización o de aplicación',
  'shell.scope.organizations': 'Organizaciones',
  'shell.scope.applications': 'Aplicaciones',
  'shell.scope.choose': 'Elige una aplicación',
  'shell.scope.loading': 'Cargando…',

  'shell.account.menu': 'Menú de la cuenta',
  'shell.account.manage': 'Gestionar tu cuenta de Oxy',
  'shell.account.signOut': 'Cerrar sesión',

  'shell.search.label': 'Buscar en Orbit',
  'shell.search.placeholder': 'Buscar',
  'shell.palette.placeholder': 'Ir a una página o ejecutar una acción…',
  'shell.palette.empty': 'No hay coincidencias.',
  'shell.palette.group.navigate': 'Ir a',
  'shell.palette.group.actions': 'Acciones',
  'shell.palette.group.applications': 'Cambiar de aplicación',
  'shell.palette.switchToLive': 'Cambiar al modo real',
  'shell.palette.switchToTest': 'Cambiar al modo de prueba',
  'shell.palette.search': 'Buscar pagos, clientes, productos…',

  'shell.testMode': 'Modo de prueba',
  'shell.testMode.hint': 'Viendo datos de prueba',
  'shell.testMode.strip':
    'Modo de prueba: estás viendo datos de prueba. Nada de esto mueve dinero real.',

  'shell.help': 'Ayuda',
  'shell.help.title': 'Atajos de teclado',
  'shell.help.palette': 'Ir a una página o ejecutar una acción',
  'shell.help.slash': 'Buscar los objetos de esta aplicación, cuando no se escribe en un campo',
  'shell.help.sidebar': 'Contraer o expandir la barra lateral',
  'shell.help.close': 'Cerrar',
  'shell.notifications': 'Notificaciones',

  'shell.breadcrumb': 'Ruta de navegación',
  'shell.list.count': '{count} mostrados',
};
