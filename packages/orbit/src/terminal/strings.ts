/**
 * The words of Orbit's Terminal screens (ADR 0024), in English and Spanish.
 * Merged into the catalogs in `i18n.ts`; `i18n.test.ts` checks both spell the
 * same keys with the same placeholders.
 */

export const TERMINAL_EN: Readonly<Record<string, string>> = {
  'nav.terminal': 'Terminal',
  'terminal.title': 'Terminal',
  'terminal.description':
    'Take card payments in person: register card readers at your locations and collect a payment on one. Every payment a reader collects is an ordinary card payment in Payments.',
  'terminal.addLocation': 'Add location',
  'terminal.registerReader': 'Register reader',

  'terminal.readers': 'Readers',
  'terminal.readers.description':
    'Each reader belongs to one location. Open one to collect a payment.',
  'terminal.readers.emptyTitle': 'No readers yet',
  'terminal.readers.emptyBody':
    'Register a reader with the code it shows. Readers are registered to a location, so add a location first.',
  'terminal.locations': 'Locations',
  'terminal.locations.description':
    'Where your readers are. The provider uses the address to configure the readers there.',
  'terminal.locations.emptyTitle': 'No locations yet',
  'terminal.locations.emptyBody':
    'Add the place where you take payments — a shop, a stand, an office. Readers are registered to a location.',
  'terminal.locationsFailed': 'The locations could not be loaded. {reason}',

  'terminal.column.label': 'Reader',
  'terminal.column.deviceType': 'Device',
  'terminal.column.location': 'Location',
  'terminal.column.lastSeen': 'Last seen',
  'terminal.column.name': 'Name',
  'terminal.column.address': 'Address',
  'terminal.noLocation': 'No location',
  'terminal.unknownLocation': 'Another location ({id})',

  'readerStatus.online': 'Online',
  'readerStatus.offline': 'Offline',
  'readerStatus.unknown': 'Not seen yet',

  'terminal.location.formTitleNew': 'Add a location',
  'terminal.location.formTitleEdit': 'Edit {name}',
  'terminal.location.displayName': 'Name',
  'terminal.location.displayNameHint': 'What you call this place, e.g. “Main street shop”.',
  'terminal.location.line1': 'Address line 1',
  'terminal.location.line2': 'Address line 2 (optional)',
  'terminal.location.city': 'City',
  'terminal.location.state': 'State or region',
  'terminal.location.postalCode': 'Postal code',
  'terminal.location.country': 'Country',
  'terminal.location.countryHint': 'Two-letter code, e.g. US, ES, GB.',
  'terminal.location.addressHint':
    'In some countries the provider needs the full address before a reader can be registered there.',
  'terminal.location.error.displayName': 'Give the location a name of at most 100 characters.',
  'terminal.location.error.country': 'Use the country’s two-letter code (ISO 3166-1), e.g. US.',
  'terminal.location.error.line': 'Each address line can be at most 500 characters.',
  'terminal.location.error.postalCode': 'The postal code can be at most 40 characters.',
  'terminal.location.create': 'Add location',
  'terminal.location.save': 'Save location',
  'terminal.location.retry': 'Try again',
  'terminal.location.failed': 'The location was not saved. {reason}',
  'terminal.location.created': 'Location added.',
  'terminal.location.saved': 'Location saved.',
  'terminal.location.edit': 'Edit',
  'terminal.location.delete': 'Delete',
  'terminal.location.deleted': 'Location deleted.',
  'terminal.location.deleteFailed': 'The location was not deleted. {reason}',
  'terminal.location.confirmDelete.title': 'Delete {name}?',
  'terminal.location.confirmDelete.body':
    'The location is removed here and at the provider. A location with readers registered to it can’t be deleted; delete those readers first.',
  'terminal.location.confirmDelete.action': 'Delete location',

  'terminal.reader.formTitle': 'Register a reader',
  'terminal.reader.code': 'Registration code',
  'terminal.reader.codeHint': 'The code the reader shows when you ask it to pair.',
  'terminal.reader.codeHintTest':
    'The code the reader shows when you ask it to pair. In test mode, “simulated-wpe” or “simulated-s700” registers a simulated reader.',
  'terminal.reader.location': 'Location',
  'terminal.reader.locationPlaceholder': 'Choose a location',
  'terminal.reader.noLocations': 'Add a location first: every reader is registered to one.',
  'terminal.reader.label': 'Label (optional)',
  'terminal.reader.labelHint': 'Your name for the reader, e.g. “Front counter”.',
  'terminal.reader.error.registrationCode':
    'Type the code the reader shows (at most 100 characters).',
  'terminal.reader.error.simulatedInLive':
    'Simulated readers exist only in test mode. In live mode, type the code a real reader shows.',
  'terminal.reader.error.location': 'Choose the location the reader is at.',
  'terminal.reader.error.label': 'At most 100 characters.',
  'terminal.reader.register': 'Register reader',
  'terminal.reader.retry': 'Try again',
  'terminal.reader.failed': 'The reader was not registered. {reason}',
  'terminal.reader.registered': 'Reader registered.',

  'reader.title': 'Reader',
  'reader.notFound': 'This reader does not exist in this mode.',
  'reader.details': 'Details',
  'reader.field.id': 'ID',
  'reader.field.deviceType': 'Device',
  'reader.field.serial': 'Serial number',
  'reader.field.location': 'Location',
  'reader.field.lastSeen': 'Last seen',
  'reader.field.status': 'Status',
  'reader.simulatedNote':
    'This is a simulated reader. Collect a payment, then press Simulate tap to present a test card. An amount ending in 05 (e.g. 10.05) is declined.',
  'reader.label': 'Label',
  'reader.label.save': 'Save label',
  'reader.label.saved': 'Label saved.',
  'reader.label.error': 'Give the reader a label of 1 to 100 characters.',
  'reader.label.failed': 'The label was not saved. {reason}',
  'reader.delete': 'Delete reader',
  'reader.deleted': 'Reader deleted.',
  'reader.deleteFailed': 'The reader was not deleted. {reason}',
  'reader.confirmDelete.title': 'Delete this reader?',
  'reader.confirmDelete.body':
    'It is unregistered here and at the provider, and can no longer collect payments until you register it again with a new code. Its past payments stay in Payments.',
  'reader.confirmDelete.action': 'Delete reader',
  'reader.confirm.keep': 'Keep it',

  'collect.title': 'Collect a payment',
  'collect.description':
    'The reader asks the customer for the card. The payment appears in Payments like any other card payment.',
  'collect.open': 'Collect a payment',
  'collect.amount': 'Amount',
  'collect.amountHint': 'In {currency}, e.g. 12.50.',
  'collect.currency': 'Currency',
  'collect.descriptionField': 'Description (optional)',
  'collect.descriptionHint': 'Shown on the payment in Orbit, e.g. what was sold.',
  'collect.manual': 'Authorize only',
  'collect.manualHint': 'Hold the amount on the card now and capture it later from the payment.',
  'collect.error.amount': 'Type a positive amount with at most the currency’s decimals.',
  'collect.error.currency': 'Choose the currency to charge. A reader never takes FairCoin.',
  'collect.error.description': 'At most 500 characters.',
  'collect.start': 'Send to reader',
  'collect.retry': 'Try again',
  'collect.close': 'Close',
  'collect.failed': 'The payment was not sent to the reader. {reason}',
  'collect.again': 'Collect another payment',

  'collect.outcome.title': 'Last payment',
  'collect.outcome.collecting.title': 'Waiting for the card',
  'collect.outcome.collecting.body':
    'The reader is asking for {amount}. The customer taps, inserts or swipes a card on the reader.',
  'collect.outcome.collectingNoAmount':
    'The reader is asking for the card. The customer taps, inserts or swipes it on the reader.',
  'collect.outcome.settling.title': 'Finishing',
  'collect.outcome.settling.body':
    'The reader is done. The payment’s outcome has not arrived yet; open the payment to see where it stands.',
  'collect.outcome.succeeded.title': 'Paid',
  'collect.outcome.succeeded.body': '{amount} was collected.',
  'collect.outcome.authorized.title': 'Authorized',
  'collect.outcome.authorized.body':
    '{amount} is held on the card and awaits capture. Capture it from the payment.',
  'collect.outcome.declined.title': 'Declined',
  'collect.outcome.declined.body':
    '{message} Nothing was charged; you can collect the payment again.',
  'collect.outcome.stopped.title': 'Cancelled',
  'collect.outcome.stopped.body':
    'The collection was cancelled before a card was read. Nothing was charged; you can collect the payment again.',
  'collect.outcome.failed.title': 'Not collected',
  'collect.outcome.failed.body':
    '{message} Nothing was charged; you can collect the payment again.',
  'collect.outcome.canceled.title': 'Payment cancelled',
  'collect.outcome.canceled.body': 'The payment was cancelled. Nothing was charged.',
  'collect.outcome.unknownFailure': 'The reader could not complete the payment.',
  'collect.outcome.declinedFallback': 'The card was declined.',
  'collect.outcome.paymentFailed': 'The payment’s status could not be read. {reason}',
  'collect.openPayment': 'Open payment',
  'collect.cancel': 'Cancel collection',
  'collect.cancelled': 'Collection cancelled.',
  'collect.cancelFailed': 'The collection was not cancelled. {reason}',
  'collect.simulate': 'Simulate tap',
  'collect.simulated': 'Test card presented.',
  'collect.simulateFailed': 'The tap was not simulated. {reason}',

  'terminal.unavailable':
    'Terminal isn’t enabled in this mode yet. The platform owner must turn on Terminal for Peable’s payment provider account in this mode; until then readers can’t be registered and payments can’t be collected.',
  'terminal.locationInUse':
    'Readers are still registered to this location. Delete those readers first, then delete the location.',
  'terminal.readerBusy':
    'The reader is busy with a payment. Cancel the collection, or wait for it to finish, then try again.',
  'terminal.readerOffline':
    'The reader is offline. Check that it is on and connected to the internet, then try again.',
  'terminal.liveGated':
    'Live payments aren’t enabled for this application yet. Collect in test mode, or ask the Peable team to enable live payments.',
  'terminal.testOnly': 'Simulating a tap only works in test mode.',
  'terminal.registrationCode':
    'The provider didn’t accept that registration code. Check the code the reader shows and type it again; simulated codes work only in test mode.',
};

export const TERMINAL_ES: Readonly<Record<string, string>> = {
  'nav.terminal': 'Terminal',
  'terminal.title': 'Terminal',
  'terminal.description':
    'Cobra con tarjeta en persona: registra lectores de tarjetas en tus ubicaciones y cobra un pago en uno de ellos. Cada pago que cobra un lector es un pago con tarjeta normal en Pagos.',
  'terminal.addLocation': 'Añadir ubicación',
  'terminal.registerReader': 'Registrar lector',

  'terminal.readers': 'Lectores',
  'terminal.readers.description':
    'Cada lector pertenece a una ubicación. Abre uno para cobrar un pago.',
  'terminal.readers.emptyTitle': 'Aún no hay lectores',
  'terminal.readers.emptyBody':
    'Registra un lector con el código que muestra. Los lectores se registran en una ubicación, así que añade primero una ubicación.',
  'terminal.locations': 'Ubicaciones',
  'terminal.locations.description':
    'Dónde están tus lectores. El proveedor usa la dirección para configurar los lectores que hay allí.',
  'terminal.locations.emptyTitle': 'Aún no hay ubicaciones',
  'terminal.locations.emptyBody':
    'Añade el lugar donde cobras: una tienda, un puesto, una oficina. Los lectores se registran en una ubicación.',
  'terminal.locationsFailed': 'No se pudieron cargar las ubicaciones. {reason}',

  'terminal.column.label': 'Lector',
  'terminal.column.deviceType': 'Dispositivo',
  'terminal.column.location': 'Ubicación',
  'terminal.column.lastSeen': 'Última conexión',
  'terminal.column.name': 'Nombre',
  'terminal.column.address': 'Dirección',
  'terminal.noLocation': 'Sin ubicación',
  'terminal.unknownLocation': 'Otra ubicación ({id})',

  'readerStatus.online': 'En línea',
  'readerStatus.offline': 'Desconectado',
  'readerStatus.unknown': 'Aún no visto',

  'terminal.location.formTitleNew': 'Añadir una ubicación',
  'terminal.location.formTitleEdit': 'Editar {name}',
  'terminal.location.displayName': 'Nombre',
  'terminal.location.displayNameHint':
    'Cómo llamas a este lugar, p. ej. «Tienda de la calle Mayor».',
  'terminal.location.line1': 'Dirección, línea 1',
  'terminal.location.line2': 'Dirección, línea 2 (opcional)',
  'terminal.location.city': 'Ciudad',
  'terminal.location.state': 'Provincia o región',
  'terminal.location.postalCode': 'Código postal',
  'terminal.location.country': 'País',
  'terminal.location.countryHint': 'Código de dos letras, p. ej. ES, US, GB.',
  'terminal.location.addressHint':
    'En algunos países el proveedor necesita la dirección completa antes de poder registrar un lector allí.',
  'terminal.location.error.displayName':
    'Pon a la ubicación un nombre de 100 caracteres como máximo.',
  'terminal.location.error.country':
    'Usa el código de dos letras del país (ISO 3166-1), p. ej. ES.',
  'terminal.location.error.line':
    'Cada línea de la dirección puede tener 500 caracteres como máximo.',
  'terminal.location.error.postalCode': 'El código postal puede tener 40 caracteres como máximo.',
  'terminal.location.create': 'Añadir ubicación',
  'terminal.location.save': 'Guardar ubicación',
  'terminal.location.retry': 'Reintentar',
  'terminal.location.failed': 'No se guardó la ubicación. {reason}',
  'terminal.location.created': 'Ubicación añadida.',
  'terminal.location.saved': 'Ubicación guardada.',
  'terminal.location.edit': 'Editar',
  'terminal.location.delete': 'Eliminar',
  'terminal.location.deleted': 'Ubicación eliminada.',
  'terminal.location.deleteFailed': 'No se eliminó la ubicación. {reason}',
  'terminal.location.confirmDelete.title': '¿Eliminar {name}?',
  'terminal.location.confirmDelete.body':
    'La ubicación se elimina aquí y en el proveedor. No se puede eliminar una ubicación con lectores registrados; elimina antes esos lectores.',
  'terminal.location.confirmDelete.action': 'Eliminar ubicación',

  'terminal.reader.formTitle': 'Registrar un lector',
  'terminal.reader.code': 'Código de registro',
  'terminal.reader.codeHint': 'El código que muestra el lector cuando le pides emparejarse.',
  'terminal.reader.codeHintTest':
    'El código que muestra el lector cuando le pides emparejarse. En modo de prueba, «simulated-wpe» o «simulated-s700» registra un lector simulado.',
  'terminal.reader.location': 'Ubicación',
  'terminal.reader.locationPlaceholder': 'Elige una ubicación',
  'terminal.reader.noLocations': 'Añade primero una ubicación: cada lector se registra en una.',
  'terminal.reader.label': 'Etiqueta (opcional)',
  'terminal.reader.labelHint': 'Tu nombre para el lector, p. ej. «Mostrador».',
  'terminal.reader.error.registrationCode':
    'Escribe el código que muestra el lector (100 caracteres como máximo).',
  'terminal.reader.error.simulatedInLive':
    'Los lectores simulados solo existen en modo de prueba. En modo real, escribe el código que muestra un lector de verdad.',
  'terminal.reader.error.location': 'Elige la ubicación donde está el lector.',
  'terminal.reader.error.label': 'Como máximo 100 caracteres.',
  'terminal.reader.register': 'Registrar lector',
  'terminal.reader.retry': 'Reintentar',
  'terminal.reader.failed': 'No se registró el lector. {reason}',
  'terminal.reader.registered': 'Lector registrado.',

  'reader.title': 'Lector',
  'reader.notFound': 'Este lector no existe en este modo.',
  'reader.details': 'Detalles',
  'reader.field.id': 'ID',
  'reader.field.deviceType': 'Dispositivo',
  'reader.field.serial': 'Número de serie',
  'reader.field.location': 'Ubicación',
  'reader.field.lastSeen': 'Última conexión',
  'reader.field.status': 'Estado',
  'reader.simulatedNote':
    'Este es un lector simulado. Cobra un pago y pulsa Simular pago con tarjeta para presentar una tarjeta de prueba. Un importe que termina en 05 (p. ej. 10.05) se rechaza.',
  'reader.label': 'Etiqueta',
  'reader.label.save': 'Guardar etiqueta',
  'reader.label.saved': 'Etiqueta guardada.',
  'reader.label.error': 'Pon al lector una etiqueta de 1 a 100 caracteres.',
  'reader.label.failed': 'No se guardó la etiqueta. {reason}',
  'reader.delete': 'Eliminar lector',
  'reader.deleted': 'Lector eliminado.',
  'reader.deleteFailed': 'No se eliminó el lector. {reason}',
  'reader.confirmDelete.title': '¿Eliminar este lector?',
  'reader.confirmDelete.body':
    'Se da de baja aquí y en el proveedor, y no podrá cobrar pagos hasta que lo registres de nuevo con un código nuevo. Sus pagos anteriores siguen en Pagos.',
  'reader.confirmDelete.action': 'Eliminar lector',
  'reader.confirm.keep': 'Conservarlo',

  'collect.title': 'Cobrar un pago',
  'collect.description':
    'El lector pide la tarjeta al cliente. El pago aparece en Pagos como cualquier otro pago con tarjeta.',
  'collect.open': 'Cobrar un pago',
  'collect.amount': 'Importe',
  'collect.amountHint': 'En {currency}, p. ej. 12.50.',
  'collect.currency': 'Moneda',
  'collect.descriptionField': 'Descripción (opcional)',
  'collect.descriptionHint': 'Se muestra en el pago en Orbit, p. ej. qué se vendió.',
  'collect.manual': 'Solo autorizar',
  'collect.manualHint':
    'Retiene el importe en la tarjeta ahora y lo capturas después desde el pago.',
  'collect.error.amount':
    'Escribe un importe positivo con, como máximo, los decimales de la moneda.',
  'collect.error.currency': 'Elige la moneda del cobro. Un lector nunca acepta FairCoin.',
  'collect.error.description': 'Como máximo 500 caracteres.',
  'collect.start': 'Enviar al lector',
  'collect.retry': 'Reintentar',
  'collect.close': 'Cerrar',
  'collect.failed': 'El pago no se envió al lector. {reason}',
  'collect.again': 'Cobrar otro pago',

  'collect.outcome.title': 'Último pago',
  'collect.outcome.collecting.title': 'Esperando la tarjeta',
  'collect.outcome.collecting.body':
    'El lector pide {amount}. El cliente acerca, inserta o desliza una tarjeta en el lector.',
  'collect.outcome.collectingNoAmount':
    'El lector pide la tarjeta. El cliente la acerca, inserta o desliza en el lector.',
  'collect.outcome.settling.title': 'Terminando',
  'collect.outcome.settling.body':
    'El lector ha terminado. Aún no ha llegado el resultado del pago; abre el pago para ver en qué estado está.',
  'collect.outcome.succeeded.title': 'Pagado',
  'collect.outcome.succeeded.body': 'Se cobraron {amount}.',
  'collect.outcome.authorized.title': 'Autorizado',
  'collect.outcome.authorized.body':
    '{amount} quedan retenidos en la tarjeta a la espera de captura. Captúralos desde el pago.',
  'collect.outcome.declined.title': 'Rechazado',
  'collect.outcome.declined.body': '{message} No se cobró nada; puedes volver a cobrar el pago.',
  'collect.outcome.stopped.title': 'Cancelado',
  'collect.outcome.stopped.body':
    'El cobro se canceló antes de leer una tarjeta. No se cobró nada; puedes volver a cobrar el pago.',
  'collect.outcome.failed.title': 'No cobrado',
  'collect.outcome.failed.body': '{message} No se cobró nada; puedes volver a cobrar el pago.',
  'collect.outcome.canceled.title': 'Pago cancelado',
  'collect.outcome.canceled.body': 'El pago se canceló. No se cobró nada.',
  'collect.outcome.unknownFailure': 'El lector no pudo completar el pago.',
  'collect.outcome.declinedFallback': 'La tarjeta fue rechazada.',
  'collect.outcome.paymentFailed': 'No se pudo leer el estado del pago. {reason}',
  'collect.openPayment': 'Abrir pago',
  'collect.cancel': 'Cancelar cobro',
  'collect.cancelled': 'Cobro cancelado.',
  'collect.cancelFailed': 'No se canceló el cobro. {reason}',
  'collect.simulate': 'Simular pago con tarjeta',
  'collect.simulated': 'Tarjeta de prueba presentada.',
  'collect.simulateFailed': 'No se simuló el pago con tarjeta. {reason}',

  'terminal.unavailable':
    'Terminal aún no está activado en este modo. El propietario de la plataforma debe activar Terminal en la cuenta del proveedor de pagos de Peable para este modo; hasta entonces no se pueden registrar lectores ni cobrar pagos.',
  'terminal.locationInUse':
    'Aún hay lectores registrados en esta ubicación. Elimina antes esos lectores y después la ubicación.',
  'terminal.readerBusy':
    'El lector está ocupado con un pago. Cancela el cobro, o espera a que termine, y vuelve a intentarlo.',
  'terminal.readerOffline':
    'El lector está desconectado. Comprueba que está encendido y conectado a internet, y vuelve a intentarlo.',
  'terminal.liveGated':
    'Los pagos reales aún no están activados para esta aplicación. Cobra en modo de prueba o pide al equipo de Peable que active los pagos reales.',
  'terminal.testOnly': 'Simular un pago con tarjeta solo funciona en modo de prueba.',
  'terminal.registrationCode':
    'El proveedor no aceptó ese código de registro. Comprueba el código que muestra el lector y escríbelo de nuevo; los códigos simulados solo funcionan en modo de prueba.',
};
