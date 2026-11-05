/**
 * The words of Orbit's page states (`states.tsx`): first run, permission,
 * session, not found, the failure banner and the loading skeletons — in
 * English and Spanish. `i18n.test.ts` keeps the two in step.
 *
 * None of them is a headline that says only that something failed: each
 * state says what is true and what to do next, and a real failure says
 * which request failed (its id) and offers Retry.
 */
export const STATES_EN: Record<string, string> = {
  'state.mode.test': 'test',
  'state.mode.live': 'live',
  'state.setup.title': 'Set up payments in {mode} mode',
  'state.setup.body.test':
    'Test mode is a sandbox: nothing here moves real money. Register this application as a merchant to start accepting test payments, then go live when you are ready.',
  'state.setup.body.live':
    'Live mode moves real money. Register this application as a merchant in live mode to accept real payments. Test mode stays available at any time.',
  'state.setup.action': 'Set up payments',
  'state.setup.useTest': 'Use test mode',
  'state.setup.docs': 'Read the integration guide',
  'state.permission.title': 'You need permission to see this',
  'state.permission.readOnlyTitle': 'You can view this, but not change it',
  'state.permission.membershipTitle': 'You are not a member of this application',
  'state.permission.body':
    'This needs the {permission} permission on the Oxy account that owns this application. An owner or admin of that account can grant it in Oxy Console.',
  'state.permission.bodyGeneric':
    'Your role on the Oxy account that owns this application does not include this. An owner or admin of that account can change it in Oxy Console.',
  'state.permission.bodyMembership':
    'Your Oxy account is not a member of the account that owns this application. Ask its owner or an admin to invite you in Oxy Console, or choose another application in the sidebar.',
  'state.permission.action': 'Open Oxy Console',
  'state.session.title': 'Your session has ended',
  'state.session.body': 'Sign in again to keep working. Nothing you saved was lost.',
  'state.session.action': 'Sign in again',
  'state.notFound.title': 'Not found',
  'state.notFound.body':
    'Nothing with this ID exists in {mode} mode. It may belong to the other mode, or it was deleted.',
  'state.tax.title': 'Tax calculation is not available yet',
  'state.tax.body':
    'Peable Tax is not turned on for this deployment, so there is nothing to configure here yet. The tax compliance workspace is still available.',
  'state.failure.network': 'Orbit could not reach Peable. Check your connection and retry.',
  'state.failure.server': 'Peable could not load this section right now.',
  'state.failure.rate_limited': 'Too many requests in a short time. Wait a moment, then retry.',
  'state.failure.unknown': 'This section could not be loaded.',
  'state.failure.invalid': 'Peable refused this request.',
  'state.failure.requestId': 'Request ID: {id}',
  'state.failure.retry': 'Retry',
  'state.failure.dismiss': 'Dismiss',
  'state.scope.failure': 'Orbit could not load your organizations and applications from Oxy.',
  'state.loading': 'Loading…',
  'state.copy': 'Copy {label}',
  'state.copied': 'Copied',
  'state.docs': 'Learn more',
};

export const STATES_ES: Record<string, string> = {
  'state.mode.test': 'prueba',
  'state.mode.live': 'real',
  'state.setup.title': 'Configura los pagos en modo {mode}',
  'state.setup.body.test':
    'El modo de prueba es un entorno aislado: nada de lo que hagas aquí mueve dinero real. Registra esta aplicación como comercio para empezar a aceptar pagos de prueba y pasa al modo real cuando quieras.',
  'state.setup.body.live':
    'El modo real mueve dinero real. Registra esta aplicación como comercio en modo real para aceptar pagos reales. El modo de prueba sigue disponible en todo momento.',
  'state.setup.action': 'Configurar pagos',
  'state.setup.useTest': 'Usar el modo de prueba',
  'state.setup.docs': 'Leer la guía de integración',
  'state.permission.title': 'Necesitas permiso para ver esto',
  'state.permission.readOnlyTitle': 'Puedes ver esto, pero no cambiarlo',
  'state.permission.membershipTitle': 'No eres miembro de esta aplicación',
  'state.permission.body':
    'Esto requiere el permiso {permission} en la cuenta de Oxy propietaria de esta aplicación. Una persona propietaria o administradora de esa cuenta puede concedértelo en Oxy Console.',
  'state.permission.bodyGeneric':
    'Tu rol en la cuenta de Oxy propietaria de esta aplicación no incluye esto. Una persona propietaria o administradora de esa cuenta puede cambiarlo en Oxy Console.',
  'state.permission.bodyMembership':
    'Tu cuenta de Oxy no es miembro de la cuenta propietaria de esta aplicación. Pide a su propietaria o a una administradora que te invite en Oxy Console, o elige otra aplicación en la barra lateral.',
  'state.permission.action': 'Abrir Oxy Console',
  'state.session.title': 'Tu sesión ha terminado',
  'state.session.body':
    'Vuelve a iniciar sesión para seguir. No se ha perdido nada de lo guardado.',
  'state.session.action': 'Iniciar sesión de nuevo',
  'state.notFound.title': 'No encontrado',
  'state.notFound.body':
    'No existe nada con este ID en modo {mode}. Puede pertenecer al otro modo o haberse eliminado.',
  'state.tax.title': 'El cálculo de impuestos aún no está disponible',
  'state.tax.body':
    'Peable Tax no está activado en este despliegue, así que todavía no hay nada que configurar aquí. El espacio de cumplimiento fiscal sigue disponible.',
  'state.failure.network':
    'Orbit no ha podido conectar con Peable. Revisa tu conexión y reinténtalo.',
  'state.failure.server': 'Peable no ha podido cargar esta sección ahora mismo.',
  'state.failure.rate_limited':
    'Demasiadas solicitudes en poco tiempo. Espera un momento y reinténtalo.',
  'state.failure.unknown': 'No se ha podido cargar esta sección.',
  'state.failure.invalid': 'Peable ha rechazado esta solicitud.',
  'state.failure.requestId': 'ID de solicitud: {id}',
  'state.failure.retry': 'Reintentar',
  'state.failure.dismiss': 'Descartar',
  'state.scope.failure': 'Orbit no ha podido cargar tus organizaciones y aplicaciones desde Oxy.',
  'state.loading': 'Cargando…',
  'state.copy': 'Copiar {label}',
  'state.copied': 'Copiado',
  'state.docs': 'Más información',
};
