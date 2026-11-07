/**
 * The words of Orbit's Identity screens (ADR 0023), in English and Spanish.
 * Merged into the catalogs in `i18n.ts`; `i18n.test.ts` checks both spell the
 * same keys with the same placeholders.
 */

export const IDENTITY_EN: Readonly<Record<string, string>> = {
  'nav.identity': 'Identity',
  'identity.title': 'Identity',
  'identity.description':
    'Verify a person’s identity document and selfie on a page hosted by the payment provider. Orbit keeps the outcome of each check — never the person’s documents, images or details.',
  'identity.new': 'Verify someone',
  'identity.filter': 'Status',
  'identity.filter.all': 'All statuses',
  'identity.column.type': 'Check',
  'identity.column.reference': 'Your reference',
  'identity.empty.title': 'No verification sessions',
  'identity.empty.body': 'No verification session has this status in this mode.',
  'identity.empty.firstTitle': 'No verifications yet',
  'identity.empty.firstBody':
    'Create a verification session and send the person its link. They verify on the provider’s page; you see whether each check passed.',
  'verificationStatus.requires_input': 'Waiting for the person',
  'verificationStatus.processing': 'Processing',
  'verificationStatus.verified': 'Verified',
  'verificationStatus.canceled': 'Cancelled',
  'verificationType.document': 'Identity document',
  'verificationType.id_number': 'ID number',
  'documentType.driving_license': 'Driving licence',
  'documentType.id_card': 'ID card',
  'documentType.passport': 'Passport',
  'checkStatus.verified': 'Verified',
  'checkStatus.unverified': 'Not verified',
  'redactionStatus.processing': 'Being erased',
  'redactionStatus.redacted': 'Erased',

  'identity.form.title': 'Verify someone',
  'identity.form.type': 'What to check',
  'identity.form.allowedTypes': 'Accepted documents',
  'identity.form.allowedTypesHint': 'None selected accepts all three.',
  'identity.form.liveCapture': 'Require a live photo',
  'identity.form.liveCaptureHint': 'The document must be captured with the camera; no uploads.',
  'identity.form.selfie': 'Require a matching selfie',
  'identity.form.selfieHint': 'A selfie is compared with the document’s photo.',
  'identity.form.idNumber': 'Also check an ID number',
  'identity.form.idNumberHint':
    'The person also enters an ID number, checked against the document.',
  'identity.form.returnUrl': 'Return URL (optional)',
  'identity.form.returnUrlHint': 'Where the provider’s page sends the person when they finish.',
  'identity.form.reference': 'Your reference (optional)',
  'identity.form.referenceHint':
    'Your own id for this person, to find the session later. Erased if you redact it.',
  'identity.form.create': 'Create verification link',
  'identity.form.retry': 'Try again',
  'identity.form.close': 'Close',
  'identity.form.error.returnUrl': 'Use an https:// address (http:// only for localhost).',
  'identity.form.error.clientReferenceId': 'At most 255 characters.',
  'identity.form.failed': 'The verification session was not created. {reason}',

  'identity.link.title': 'Send this link to the person',
  'identity.link.body':
    'It opens the provider’s verification page. It works once and expires after 48 hours. The list never shows it again; while the session waits for the person, its page here does.',
  'identity.link.copied': 'Link copied.',
  'identity.link.open': 'Open session',

  'identity.unavailable':
    'Identity verification isn’t enabled for this mode yet. Ask the Peable team to turn it on.',
  'identity.state':
    'This verification session changed and no longer allows that. The page now shows where it stands.',

  'verification.title': 'Verification session',
  'verification.notFound': 'This verification session does not exist in this mode.',
  'verification.details': 'Details',
  'verification.field.id': 'ID',
  'verification.field.type': 'Check',
  'verification.field.reference': 'Your reference',
  'verification.field.returnUrl': 'Return URL',
  'verification.field.allowedTypes': 'Accepted documents',
  'verification.field.allowedTypesAll': 'Any',
  'verification.field.liveCapture': 'Live photo',
  'verification.field.selfie': 'Matching selfie',
  'verification.field.idNumber': 'ID number',
  'verification.field.redaction': 'Redaction',
  'verification.required': 'Required',
  'verification.notRequired': 'Not required',
  'verification.lastError': 'Last attempt failed',
  'verification.lastErrorHint':
    'The person can try again with the same link while it is valid, or you can send a new one.',
  'verification.redactedNote':
    'The person’s data was erased at the provider, with your reference and metadata here. Only the outcomes remain.',
  'verification.reports': 'Attempts',
  'verification.reportsEmpty': 'No attempt has been submitted yet.',
  'verification.report': 'Attempt {id}',
  'verification.check.document': 'Document',
  'verification.check.id_number': 'ID number',
  'verification.check.selfie': 'Selfie',
  'verification.noPersonalData':
    'Orbit shows whether each check passed, never the person’s document, photos or details.',
  'verification.reportsFailed': 'The attempts could not be loaded. {reason}',
  'verification.action.cancel': 'Cancel session',
  'verification.action.redact': 'Redact',
  'verification.done.cancel': 'Verification session cancelled.',
  'verification.done.redact':
    'Redaction started. The provider erases the person’s data within four days.',
  'verification.confirmCancel.title': 'Cancel this verification session?',
  'verification.confirmCancel.body':
    'Its link stops working and the person can never submit it. You can create a new session later.',
  'verification.confirmCancel.action': 'Cancel session',
  'verification.confirmRedact.title': 'Erase this person’s data?',
  'verification.confirmRedact.body':
    'The provider erases the documents, photos and details it collected, and Orbit erases your reference and metadata on this session and its events. This cannot be undone. A session still waiting for the person is also cancelled.',
  'verification.confirmRedact.action': 'Erase permanently',
  'verification.confirm.keep': 'Keep it',
  'verification.redactWaits':
    'Redaction is available once the provider finishes processing this session.',
};

export const IDENTITY_ES: Readonly<Record<string, string>> = {
  'nav.identity': 'Identidad',
  'identity.title': 'Identidad',
  'identity.description':
    'Verifica el documento de identidad y el selfi de una persona en una página alojada por el proveedor de pagos. Orbit guarda el resultado de cada comprobación, nunca los documentos, las imágenes ni los datos de la persona.',
  'identity.new': 'Verificar a alguien',
  'identity.filter': 'Estado',
  'identity.filter.all': 'Todos los estados',
  'identity.column.type': 'Comprobación',
  'identity.column.reference': 'Tu referencia',
  'identity.empty.title': 'No hay sesiones de verificación',
  'identity.empty.body': 'Ninguna sesión de verificación tiene este estado en este modo.',
  'identity.empty.firstTitle': 'Aún no hay verificaciones',
  'identity.empty.firstBody':
    'Crea una sesión de verificación y envía su enlace a la persona. Se verifica en la página del proveedor; tú ves si cada comprobación se superó.',
  'verificationStatus.requires_input': 'Esperando a la persona',
  'verificationStatus.processing': 'Procesando',
  'verificationStatus.verified': 'Verificada',
  'verificationStatus.canceled': 'Cancelada',
  'verificationType.document': 'Documento de identidad',
  'verificationType.id_number': 'Número de identificación',
  'documentType.driving_license': 'Permiso de conducir',
  'documentType.id_card': 'Documento nacional de identidad',
  'documentType.passport': 'Pasaporte',
  'checkStatus.verified': 'Verificado',
  'checkStatus.unverified': 'No verificado',
  'redactionStatus.processing': 'Borrándose',
  'redactionStatus.redacted': 'Borrada',

  'identity.form.title': 'Verificar a alguien',
  'identity.form.type': 'Qué comprobar',
  'identity.form.allowedTypes': 'Documentos aceptados',
  'identity.form.allowedTypesHint': 'Si no seleccionas ninguno, se aceptan los tres.',
  'identity.form.liveCapture': 'Exigir una foto en directo',
  'identity.form.liveCaptureHint':
    'El documento debe capturarse con la cámara; sin subir archivos.',
  'identity.form.selfie': 'Exigir un selfi coincidente',
  'identity.form.selfieHint': 'Se compara un selfi con la foto del documento.',
  'identity.form.idNumber': 'Comprobar también un número de identificación',
  'identity.form.idNumberHint':
    'La persona introduce también un número de identificación, que se coteja con el documento.',
  'identity.form.returnUrl': 'URL de retorno (opcional)',
  'identity.form.returnUrlHint': 'Adónde envía a la persona la página del proveedor al terminar.',
  'identity.form.reference': 'Tu referencia (opcional)',
  'identity.form.referenceHint':
    'Tu propio identificador de esta persona, para encontrar la sesión después. Se borra si la eliminas.',
  'identity.form.create': 'Crear enlace de verificación',
  'identity.form.retry': 'Reintentar',
  'identity.form.close': 'Cerrar',
  'identity.form.error.returnUrl': 'Usa una dirección https:// (http:// solo para localhost).',
  'identity.form.error.clientReferenceId': 'Como máximo 255 caracteres.',
  'identity.form.failed': 'No se creó la sesión de verificación. {reason}',

  'identity.link.title': 'Envía este enlace a la persona',
  'identity.link.body':
    'Abre la página de verificación del proveedor. Funciona una sola vez y caduca a las 48 horas. La lista no vuelve a mostrarlo; mientras la sesión espera a la persona, su página aquí sí.',
  'identity.link.copied': 'Enlace copiado.',
  'identity.link.open': 'Abrir sesión',

  'identity.unavailable':
    'La verificación de identidad aún no está activada en este modo. Pide al equipo de Peable que la active.',
  'identity.state':
    'Esta sesión de verificación cambió y ya no lo permite. La página muestra ahora su estado actual.',

  'verification.title': 'Sesión de verificación',
  'verification.notFound': 'Esta sesión de verificación no existe en este modo.',
  'verification.details': 'Detalles',
  'verification.field.id': 'ID',
  'verification.field.type': 'Comprobación',
  'verification.field.reference': 'Tu referencia',
  'verification.field.returnUrl': 'URL de retorno',
  'verification.field.allowedTypes': 'Documentos aceptados',
  'verification.field.allowedTypesAll': 'Cualquiera',
  'verification.field.liveCapture': 'Foto en directo',
  'verification.field.selfie': 'Selfi coincidente',
  'verification.field.idNumber': 'Número de identificación',
  'verification.field.redaction': 'Borrado',
  'verification.required': 'Exigido',
  'verification.notRequired': 'No exigido',
  'verification.lastError': 'El último intento falló',
  'verification.lastErrorHint':
    'La persona puede volver a intentarlo con el mismo enlace mientras sea válido, o puedes enviarle uno nuevo.',
  'verification.redactedNote':
    'Los datos de la persona se borraron en el proveedor, junto con tu referencia y tus metadatos aquí. Solo quedan los resultados.',
  'verification.reports': 'Intentos',
  'verification.reportsEmpty': 'Aún no se ha enviado ningún intento.',
  'verification.report': 'Intento {id}',
  'verification.check.document': 'Documento',
  'verification.check.id_number': 'Número de identificación',
  'verification.check.selfie': 'Selfi',
  'verification.noPersonalData':
    'Orbit muestra si cada comprobación se superó, nunca el documento, las fotos ni los datos de la persona.',
  'verification.reportsFailed': 'No se pudieron cargar los intentos. {reason}',
  'verification.action.cancel': 'Cancelar sesión',
  'verification.action.redact': 'Borrar datos',
  'verification.done.cancel': 'Sesión de verificación cancelada.',
  'verification.done.redact':
    'Borrado iniciado. El proveedor borra los datos de la persona en un plazo de cuatro días.',
  'verification.confirmCancel.title': '¿Cancelar esta sesión de verificación?',
  'verification.confirmCancel.body':
    'Su enlace deja de funcionar y la persona ya no podrá enviarla. Puedes crear una sesión nueva más adelante.',
  'verification.confirmCancel.action': 'Cancelar sesión',
  'verification.confirmRedact.title': '¿Borrar los datos de esta persona?',
  'verification.confirmRedact.body':
    'El proveedor borra los documentos, las fotos y los datos que recogió, y Orbit borra tu referencia y tus metadatos de esta sesión y de sus eventos. No se puede deshacer. Una sesión que aún espera a la persona también se cancela.',
  'verification.confirmRedact.action': 'Borrar para siempre',
  'verification.confirm.keep': 'Conservarla',
  'verification.redactWaits':
    'El borrado está disponible cuando el proveedor termine de procesar esta sesión.',
};
