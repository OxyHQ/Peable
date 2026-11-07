/**
 * The words of Orbit's Risk rules and Reviews screens (ADR 0022), in English
 * and Spanish. Merged into the catalogs in `i18n.ts`; `i18n.test.ts` checks
 * both spell the same keys with the same placeholders.
 */

export const RADAR_EN: Readonly<Record<string, string>> = {
  'nav.radar': 'Risk rules',
  'nav.reviews': 'Reviews',

  'radar.title': 'Risk rules',
  'radar.description':
    'Your own rules for card payments: allow, block or send a payment to review when its facts match a condition. Up to {max} rules in each mode.',
  'radar.precedence':
    'When several rules match, allow beats block, and block beats review. Among rules with the same action, the oldest is reported.',
  'radar.cardOnly': 'Rules judge card payments only; FairCoin payments never consult them.',
  'radar.new': 'New rule',
  'radar.newIntro':
    'Choose what the rule does and write the condition. Orbit checks the condition as you type, and you can test it against recent payments before saving.',
  'radar.filter': 'Action',
  'radar.filter.all': 'All actions',
  'radar.empty.title': 'No rules',
  'radar.empty.body': 'No rule has this action in this mode.',
  'radar.empty.firstTitle': 'No risk rules yet',
  'radar.empty.firstBody':
    'Block card payments you never want, send unusual ones to review, or allow the ones you trust — by amount, currency, card country, customer, email or how often they pay.',
  'radar.version': 'Version {version}',
  'radar.updated': 'Updated {at}',
  'radar.ruleVersion': '{id} · version {version}',
  'radar.enabled': 'On',
  'radar.disabled': 'Off',
  'radar.enabledFor': 'Rule {id} on',
  'radar.enabledNow': 'Rule turned on. It judges the next card payment.',
  'radar.disabledNow': 'Rule turned off. It no longer judges payments.',
  'radar.edit': 'Edit',
  'radar.view': 'View',
  'radar.delete': 'Delete rule',
  'radar.deleted': 'Rule deleted. Past evaluations and reviews keep it as it was.',
  'radar.confirmDelete.title': 'Delete this rule?',
  'radar.confirmDelete.body':
    'It stops judging payments at once. Evaluations and reviews it already made keep the rule as it was. To pause it instead, turn it off.',
  'radar.confirmDelete.action': 'Delete rule',

  'radar.rule.title': 'Risk rule',
  'radar.rule.notFound': 'This rule does not exist in this mode. It may have been deleted.',
  'radar.field.version': 'Version',
  'radar.field.status': 'Status',
  'radar.field.created': 'Created',
  'radar.field.updated': 'Updated',

  'radar.action.allow': 'Allow',
  'radar.action.block': 'Block',
  'radar.action.review': 'Review',
  'radar.actionHelp.allow':
    'Allow: a matching payment is never blocked or reviewed by your other rules. Use it for customers you trust.',
  'radar.actionHelp.block':
    'Block: a matching payment is declined like a declined card. It stays payable with another card, or with FairCoin on its order.',
  'radar.actionHelp.review':
    'Review: a matching payment goes to your review queue after authorization, where you approve or refuse it.',

  'radar.form.action': 'What the rule does',
  'radar.form.predicate': 'Condition',
  'radar.form.predicateHelp':
    "Facts between colons, compared with values: :amount: > 100000 and :currency: = 'EUR'. Amounts are in base units (cents). Text comparisons ignore case. Use and, or, not, in (…), like '%…' and is_missing(:fact:).",
  'radar.form.details': 'Details',
  'radar.form.description': 'Description',
  'radar.form.descriptionHint': 'Optional. Why this rule exists, for your team.',
  'radar.form.enabled': 'On',
  'radar.form.enabledHint': 'A rule that is off is kept but judges nothing.',
  'radar.form.newVersion':
    'Saving makes this version {version}. Evaluations record the version that decided.',
  'radar.form.create': 'Create rule',
  'radar.form.save': 'Save rule',
  'radar.form.created': 'Rule created.',
  'radar.form.saved': 'Rule saved.',
  'radar.form.fixErrors': 'Fix the marked fields first.',

  'radar.predicate.empty': 'Write a condition, or press a fact on the right to add it.',
  'radar.predicate.checking': 'Checking the condition…',
  'radar.predicate.valid': 'This condition is valid. It reads: {facts}.',
  'radar.predicate.validNoFacts': 'This condition is valid.',
  'radar.predicate.invalid': 'This condition does not parse: {reason}.',
  'radar.predicate.invalidAt':
    'This condition does not parse: {reason} — at character {position}, marked below.',
  'radar.predicate.end': '⏎',
  'radar.predicate.unchecked':
    'Orbit could not check the condition just now ({reason}). It is checked again when you save.',

  'radar.timing.before':
    'This rule reads only facts known before authorization, so it judges every card payment before the card is charged.',
  'radar.timing.card':
    "This rule reads the card's country, brand or funding. Those are known before authorization only when you confirm with a saved card from your server; when the payer enters a card in the checkout, they are known only after authorization.",
  'radar.timing.after':
    "This rule reads the provider's risk level or score, which exist only after authorization. It is judged once, when the charge is first read.",
  'radar.consequence.blockBefore':
    'A block declines the attempt before any money moves; the payment stays payable.',
  'radar.consequence.blockAfter':
    'So on an automatically captured payment a block cannot stop the charge: the payment opens a review instead, and you refuse (refund) or approve it. With manual capture, a block releases the authorization before any money moves.',
  'radar.consequence.review':
    'A review opens after authorization. With manual capture, capture waits until you approve it.',
  'radar.consequence.allow': 'An allow wins over every block and review rule that also matches.',

  'radar.facts.title': 'Facts',
  'radar.facts.body':
    'Every fact a condition may use, its type and when it is known. A fact that is not known never makes a rule match.',
  'radar.facts.insert': 'Add :{fact}: to the condition',
  'radar.facts.syntax':
    "Integers are compared as base units with =, !=, <, <=, >, >=; text with =, !=, in ('A', 'B') and like 'gmail%'.",
  'radar.factType.integer': 'Integer',
  'radar.factType.string': 'Text',
  'radar.availability.before': 'Before authorization',
  'radar.availability.card': 'With a saved card; otherwise after authorization',
  'radar.availability.after': 'After authorization only',
  'radar.fact.value': ':{name}: = {value}',
  'radar.fact.unknown': ':{name}: unknown',

  'radar.preview.title': 'Test against recent payments',
  'radar.preview.body':
    'Judges the condition, unsaved, against your {count} most recent card payments in this mode. Nothing is changed.',
  'radar.preview.run': 'Test condition',
  'radar.preview.needsValid': 'Write a valid condition to test it.',
  'radar.preview.result': 'Matched {matched} of the {evaluated} most recent card payments.',
  'radar.preview.noPayments': 'There are no card payments in this mode to test against yet.',
  'radar.preview.velocityNote':
    'Counts and totals per customer or email are read as of now, not as they were when each payment was made.',

  'radar.error.required': 'Required.',
  'radar.error.too_long': 'At most {max} characters.',
  'radar.error.server': 'The gateway refused this field; see the message above.',
  'radar.error.limit':
    'This mode already has {max} rules, the most it can hold. Delete a rule you no longer need, then create this one.',

  'radar.decision.allow': 'Allowed',
  'radar.decision.block': 'Blocked',
  'radar.decision.review': 'Sent to review',
  'radar.phase.pre_authorization': 'Before authorization',
  'radar.phase.post_authorization': 'After authorization',
  'radar.payment.title': 'Risk rules',
  'radar.payment.body':
    'Every rule that matched this payment, as it was when it decided, with the facts it read.',
  'radar.payment.none': 'No risk rule matched this payment.',
  'radar.payment.review': 'Review',

  'payment.field.review': 'Review',

  'reviews.title': 'Reviews',
  'reviews.description':
    'Card payments your rules held for a person. Approve to let a held capture proceed; refuse to release the authorization or refund the payment in full.',
  'reviews.filter': 'Queue',
  'reviews.filter.open': 'Open',
  'reviews.filter.closed': 'Closed',
  'reviews.empty.openTitle': 'Nothing to review',
  'reviews.empty.openBody':
    'No payment is waiting for you in this mode. A review rule, or a block that could not act before capture, puts one here.',
  'reviews.empty.closedTitle': 'No closed reviews',
  'reviews.empty.closedBody': 'No review has been closed in this mode yet.',

  'review.title': 'Review',
  'review.notFound': 'This review does not exist in this mode.',
  'review.details': 'Details',
  'review.status.open': 'Open',
  'review.status.closed': 'Closed',
  'review.openedReason.rule': 'Opened by a rule',
  'review.closedReason.approved': 'Approved',
  'review.closedReason.refunded': 'Refunded',
  'review.closedReason.refunded_as_fraud': 'Refunded as fraud',
  'review.closedReason.canceled': 'Authorization released',
  'review.closedReason.disputed': 'Disputed',
  'review.openedAt': '{reason} · {at}',
  'review.closedAt': '{reason} · {at}',
  'review.field.id': 'ID',
  'review.field.payment': 'Payment',
  'review.field.paymentStatus': 'Payment status',
  'review.field.charge': 'Charge',
  'review.field.opened': 'Opened',
  'review.field.created': 'Created',
  'review.field.closedReason': 'Closed as',
  'review.field.closed': 'Closed',
  'review.rule': 'The rule that opened it',
  'review.ruleBody': 'As it was when it decided.',
  'review.decide': 'Decide',
  'review.decideBody':
    'Approve if the payment is genuine: a held capture may then proceed. Refuse if it is not.',
  'review.refuseWarning':
    'Refusing releases an uncaptured authorization, or refunds a captured payment in full. It cannot be undone.',
  'review.approve': 'Approve',
  'review.refuse': 'Refuse',
  'review.approved': 'Review approved.',
  'review.refused': 'Review refused.',
  'review.refusalReason': 'Refusal reason',
  'review.refusalReason.fraudulent': 'Fraudulent',
  'review.refusalReason.requested_by_customer': 'Requested by the customer',
  'review.refusalReason.none': 'No reason given',
  'review.confirmRefuse.title': 'Refuse this payment?',
  'review.confirmRefuse.body':
    'If the payment is only authorized, the authorization is released; if it was captured, it is refunded in full. Reason: {reason}. This happens once and cannot be undone.',
  'review.confirmRefuse.action': 'Refuse payment',
  'review.error.notOpen':
    'This review was already closed — someone approved or refused it, or the payment was refunded, cancelled or disputed. Orbit has read it again.',
  'review.error.inProgress':
    'A refusal of this review is already in progress. Wait a moment; Orbit has read it again.',
  'review.error.paymentState':
    'The payment is no longer in a state this action applies to. Orbit has read it again; check its status before deciding.',
  'review.error.provider':
    'The card provider did not answer, so nothing changed. Try again in a moment.',
  'review.error.request': '(request {id})',
};

export const RADAR_ES: Readonly<Record<string, string>> = {
  'nav.radar': 'Reglas de riesgo',
  'nav.reviews': 'Revisiones',

  'radar.title': 'Reglas de riesgo',
  'radar.description':
    'Tus propias reglas para pagos con tarjeta: permitir, bloquear o enviar un pago a revisión cuando sus datos cumplen una condición. Hasta {max} reglas en cada modo.',
  'radar.precedence':
    'Cuando coinciden varias reglas, permitir gana a bloquear, y bloquear gana a revisar. Entre reglas con la misma acción se indica la más antigua.',
  'radar.cardOnly':
    'Las reglas solo juzgan pagos con tarjeta; los pagos en FairCoin nunca las consultan.',
  'radar.new': 'Nueva regla',
  'radar.newIntro':
    'Elige qué hace la regla y escribe la condición. Orbit la comprueba mientras escribes, y puedes probarla con pagos recientes antes de guardarla.',
  'radar.filter': 'Acción',
  'radar.filter.all': 'Todas las acciones',
  'radar.empty.title': 'No hay reglas',
  'radar.empty.body': 'Ninguna regla tiene esta acción en este modo.',
  'radar.empty.firstTitle': 'Aún no hay reglas de riesgo',
  'radar.empty.firstBody':
    'Bloquea los pagos con tarjeta que nunca quieres, envía a revisión los inusuales o permite los de confianza — por importe, moneda, país de la tarjeta, cliente, correo o frecuencia de pago.',
  'radar.version': 'Versión {version}',
  'radar.updated': 'Actualizada {at}',
  'radar.ruleVersion': '{id} · versión {version}',
  'radar.enabled': 'Activa',
  'radar.disabled': 'Inactiva',
  'radar.enabledFor': 'Regla {id} activa',
  'radar.enabledNow': 'Regla activada. Juzga el próximo pago con tarjeta.',
  'radar.disabledNow': 'Regla desactivada. Ya no juzga pagos.',
  'radar.edit': 'Editar',
  'radar.view': 'Ver',
  'radar.delete': 'Eliminar regla',
  'radar.deleted':
    'Regla eliminada. Las evaluaciones y revisiones anteriores la conservan tal como era.',
  'radar.confirmDelete.title': '¿Eliminar esta regla?',
  'radar.confirmDelete.body':
    'Deja de juzgar pagos de inmediato. Las evaluaciones y revisiones que ya hizo conservan la regla tal como era. Para pausarla, desactívala.',
  'radar.confirmDelete.action': 'Eliminar regla',

  'radar.rule.title': 'Regla de riesgo',
  'radar.rule.notFound': 'Esta regla no existe en este modo. Puede que se haya eliminado.',
  'radar.field.version': 'Versión',
  'radar.field.status': 'Estado',
  'radar.field.created': 'Creada',
  'radar.field.updated': 'Actualizada',

  'radar.action.allow': 'Permitir',
  'radar.action.block': 'Bloquear',
  'radar.action.review': 'Revisar',
  'radar.actionHelp.allow':
    'Permitir: tus otras reglas nunca bloquean ni envían a revisión un pago que coincide. Úsala para clientes de confianza.',
  'radar.actionHelp.block':
    'Bloquear: un pago que coincide se rechaza como una tarjeta rechazada. Sigue pudiéndose pagar con otra tarjeta, o con FairCoin en su pedido.',
  'radar.actionHelp.review':
    'Revisar: un pago que coincide pasa a tu cola de revisión tras la autorización, donde lo apruebas o lo rechazas.',

  'radar.form.action': 'Qué hace la regla',
  'radar.form.predicate': 'Condición',
  'radar.form.predicateHelp':
    "Datos entre dos puntos, comparados con valores: :amount: > 100000 and :currency: = 'EUR'. Los importes van en unidades base (céntimos). Las comparaciones de texto no distinguen mayúsculas. Usa and, or, not, in (…), like '%…' e is_missing(:dato:).",
  'radar.form.details': 'Detalles',
  'radar.form.description': 'Descripción',
  'radar.form.descriptionHint': 'Opcional. Por qué existe esta regla, para tu equipo.',
  'radar.form.enabled': 'Activa',
  'radar.form.enabledHint': 'Una regla inactiva se conserva pero no juzga nada.',
  'radar.form.newVersion':
    'Al guardar, esta pasa a ser la versión {version}. Las evaluaciones registran la versión que decidió.',
  'radar.form.create': 'Crear regla',
  'radar.form.save': 'Guardar regla',
  'radar.form.created': 'Regla creada.',
  'radar.form.saved': 'Regla guardada.',
  'radar.form.fixErrors': 'Corrige primero los campos marcados.',

  'radar.predicate.empty': 'Escribe una condición, o pulsa un dato a la derecha para añadirlo.',
  'radar.predicate.checking': 'Comprobando la condición…',
  'radar.predicate.valid': 'Esta condición es válida. Lee: {facts}.',
  'radar.predicate.validNoFacts': 'Esta condición es válida.',
  'radar.predicate.invalid': 'Esta condición no se puede interpretar: {reason}.',
  'radar.predicate.invalidAt':
    'Esta condición no se puede interpretar: {reason} — en el carácter {position}, marcado abajo.',
  'radar.predicate.end': '⏎',
  'radar.predicate.unchecked':
    'Orbit no pudo comprobar la condición ahora ({reason}). Se vuelve a comprobar al guardar.',

  'radar.timing.before':
    'Esta regla solo lee datos conocidos antes de la autorización, así que juzga cada pago con tarjeta antes de cargarla.',
  'radar.timing.card':
    'Esta regla lee el país, la marca o el tipo de la tarjeta. Solo se conocen antes de la autorización cuando confirmas con una tarjeta guardada desde tu servidor; cuando el pagador introduce una tarjeta en el checkout, se conocen solo tras la autorización.',
  'radar.timing.after':
    'Esta regla lee el nivel o la puntuación de riesgo del proveedor, que solo existen tras la autorización. Se juzga una vez, cuando se lee el cargo por primera vez.',
  'radar.consequence.blockBefore':
    'Un bloqueo rechaza el intento antes de que se mueva dinero; el pago sigue pudiéndose pagar.',
  'radar.consequence.blockAfter':
    'Así que en un pago capturado automáticamente un bloqueo no puede detener el cargo: el pago abre una revisión, y tú lo rechazas (reembolsas) o lo apruebas. Con captura manual, un bloqueo libera la autorización antes de que se mueva dinero.',
  'radar.consequence.review':
    'La revisión se abre tras la autorización. Con captura manual, la captura espera a que la apruebes.',
  'radar.consequence.allow':
    'Permitir gana a todas las reglas de bloqueo y de revisión que también coincidan.',

  'radar.facts.title': 'Datos',
  'radar.facts.body':
    'Cada dato que puede usar una condición, su tipo y cuándo se conoce. Un dato desconocido nunca hace que una regla coincida.',
  'radar.facts.insert': 'Añadir :{fact}: a la condición',
  'radar.facts.syntax':
    "Los enteros se comparan en unidades base con =, !=, <, <=, >, >=; el texto con =, !=, in ('A', 'B') y like 'gmail%'.",
  'radar.factType.integer': 'Entero',
  'radar.factType.string': 'Texto',
  'radar.availability.before': 'Antes de la autorización',
  'radar.availability.card': 'Con una tarjeta guardada; si no, tras la autorización',
  'radar.availability.after': 'Solo tras la autorización',
  'radar.fact.value': ':{name}: = {value}',
  'radar.fact.unknown': ':{name}: desconocido',

  'radar.preview.title': 'Probar con pagos recientes',
  'radar.preview.body':
    'Juzga la condición, sin guardarla, con tus {count} pagos con tarjeta más recientes en este modo. No se cambia nada.',
  'radar.preview.run': 'Probar condición',
  'radar.preview.needsValid': 'Escribe una condición válida para probarla.',
  'radar.preview.result':
    'Coincide con {matched} de los {evaluated} pagos con tarjeta más recientes.',
  'radar.preview.noPayments': 'Aún no hay pagos con tarjeta en este modo con los que probar.',
  'radar.preview.velocityNote':
    'Los recuentos y totales por cliente o correo se leen a fecha de hoy, no como eran cuando se hizo cada pago.',

  'radar.error.required': 'Obligatorio.',
  'radar.error.too_long': 'Como máximo {max} caracteres.',
  'radar.error.server': 'La pasarela rechazó este campo; consulta el mensaje de arriba.',
  'radar.error.limit':
    'Este modo ya tiene {max} reglas, el máximo que admite. Elimina una regla que ya no necesites y crea esta después.',

  'radar.decision.allow': 'Permitido',
  'radar.decision.block': 'Bloqueado',
  'radar.decision.review': 'Enviado a revisión',
  'radar.phase.pre_authorization': 'Antes de la autorización',
  'radar.phase.post_authorization': 'Tras la autorización',
  'radar.payment.title': 'Reglas de riesgo',
  'radar.payment.body':
    'Cada regla que coincidió con este pago, tal como era cuando decidió, con los datos que leyó.',
  'radar.payment.none': 'Ninguna regla de riesgo coincidió con este pago.',
  'radar.payment.review': 'Revisión',

  'payment.field.review': 'Revisión',

  'reviews.title': 'Revisiones',
  'reviews.description':
    'Pagos con tarjeta que tus reglas retuvieron para una persona. Aprueba para que una captura retenida continúe; rechaza para liberar la autorización o reembolsar el pago completo.',
  'reviews.filter': 'Cola',
  'reviews.filter.open': 'Abiertas',
  'reviews.filter.closed': 'Cerradas',
  'reviews.empty.openTitle': 'Nada que revisar',
  'reviews.empty.openBody':
    'Ningún pago te espera en este modo. Aparecen aquí por una regla de revisión, o por un bloqueo que no pudo actuar antes de la captura.',
  'reviews.empty.closedTitle': 'No hay revisiones cerradas',
  'reviews.empty.closedBody': 'Aún no se ha cerrado ninguna revisión en este modo.',

  'review.title': 'Revisión',
  'review.notFound': 'Esta revisión no existe en este modo.',
  'review.details': 'Detalles',
  'review.status.open': 'Abierta',
  'review.status.closed': 'Cerrada',
  'review.openedReason.rule': 'Abierta por una regla',
  'review.closedReason.approved': 'Aprobada',
  'review.closedReason.refunded': 'Reembolsada',
  'review.closedReason.refunded_as_fraud': 'Reembolsada por fraude',
  'review.closedReason.canceled': 'Autorización liberada',
  'review.closedReason.disputed': 'Disputada',
  'review.openedAt': '{reason} · {at}',
  'review.closedAt': '{reason} · {at}',
  'review.field.id': 'ID',
  'review.field.payment': 'Pago',
  'review.field.paymentStatus': 'Estado del pago',
  'review.field.charge': 'Cargo',
  'review.field.opened': 'Abierta',
  'review.field.created': 'Creada',
  'review.field.closedReason': 'Cerrada como',
  'review.field.closed': 'Cerrada',
  'review.rule': 'La regla que la abrió',
  'review.ruleBody': 'Tal como era cuando decidió.',
  'review.decide': 'Decidir',
  'review.decideBody':
    'Aprueba si el pago es legítimo: una captura retenida podrá continuar. Recházalo si no lo es.',
  'review.refuseWarning':
    'Rechazar libera una autorización no capturada, o reembolsa por completo un pago capturado. No se puede deshacer.',
  'review.approve': 'Aprobar',
  'review.refuse': 'Rechazar',
  'review.approved': 'Revisión aprobada.',
  'review.refused': 'Revisión rechazada.',
  'review.refusalReason': 'Motivo del rechazo',
  'review.refusalReason.fraudulent': 'Fraudulento',
  'review.refusalReason.requested_by_customer': 'Solicitado por el cliente',
  'review.refusalReason.none': 'Sin motivo',
  'review.confirmRefuse.title': '¿Rechazar este pago?',
  'review.confirmRefuse.body':
    'Si el pago solo está autorizado, se libera la autorización; si se capturó, se reembolsa por completo. Motivo: {reason}. Ocurre una sola vez y no se puede deshacer.',
  'review.confirmRefuse.action': 'Rechazar pago',
  'review.error.notOpen':
    'Esta revisión ya estaba cerrada — alguien la aprobó o la rechazó, o el pago se reembolsó, canceló o disputó. Orbit la ha vuelto a leer.',
  'review.error.inProgress':
    'Ya hay un rechazo de esta revisión en curso. Espera un momento; Orbit la ha vuelto a leer.',
  'review.error.paymentState':
    'El pago ya no está en un estado al que se aplique esta acción. Orbit lo ha vuelto a leer; revisa su estado antes de decidir.',
  'review.error.provider':
    'El proveedor de tarjetas no respondió, así que no ha cambiado nada. Inténtalo de nuevo en un momento.',
  'review.error.request': '(solicitud {id})',
};
