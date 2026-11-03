/**
 * The words of Orbit's Reports screen, in English and Spanish. Merged into the
 * catalogs in `i18n.ts`; `i18n.test.ts` checks both spell the same keys with
 * the same placeholders.
 */

export const REPORTS_EN: Readonly<Record<string, string>> = {
  'nav.reports': 'Reports',
  'reports.title': 'Reports',
  'reports.description':
    'Reports are produced in the background as CSV files. Amounts are in each currency’s smallest unit, as on the API; times are UTC.',
  'reports.run.title': 'Run a report',
  'reports.run.intro':
    'Choose a report and the days it covers. The last day is included; a report never covers time that has not passed yet.',
  'reports.run.type': 'Report',
  'reports.run.start': 'From (YYYY-MM-DD, UTC)',
  'reports.run.end': 'To, inclusive (YYYY-MM-DD, UTC)',
  'reports.run.currency': 'Currency',
  'reports.run.allCurrencies': 'All currencies',
  'reports.run.submit': 'Run report',
  'reports.run.retry': 'Try the same request again',
  'reports.run.created': 'Report requested. It appears below as soon as it is ready.',
  'reports.run.available': 'Data from {date}.',
  'reports.invalid.type': 'Choose a report.',
  'reports.invalid.start': 'Enter the first day as YYYY-MM-DD.',
  'reports.invalid.end': 'Enter the last day as YYYY-MM-DD.',
  'reports.invalid.order': 'The last day must not be before the first.',
  'reports.invalid.future': 'The first day has not happened yet.',
  'reports.list': 'Report runs',
  'reports.empty.title': 'No reports yet',
  'reports.empty.body': 'Run a report above; it is listed here with its file once ready.',
  'reports.column.report': 'Report',
  'reports.column.interval': 'Covers',
  'reports.column.status': 'Status',
  'reports.column.created': 'Requested',
  'reports.status.pending': 'Being produced',
  'reports.status.succeeded': 'Ready',
  'reports.status.failed': 'Failed',
  'reports.download': 'Download CSV',
  'reports.downloadFailed': 'The report could not be downloaded.',
  'reports.downloadWebOnly': 'Download the report from Orbit in a browser.',
  'reports.unavailable': 'The file is no longer available.',
};

export const REPORTS_ES: Readonly<Record<string, string>> = {
  'nav.reports': 'Informes',
  'reports.title': 'Informes',
  'reports.description':
    'Los informes se generan en segundo plano como archivos CSV. Los importes van en la unidad mínima de cada moneda, como en la API; las horas, en UTC.',
  'reports.run.title': 'Generar un informe',
  'reports.run.intro':
    'Elige un informe y los días que abarca. El último día se incluye; un informe nunca abarca un tiempo que aún no ha pasado.',
  'reports.run.type': 'Informe',
  'reports.run.start': 'Desde (AAAA-MM-DD, UTC)',
  'reports.run.end': 'Hasta, incluido (AAAA-MM-DD, UTC)',
  'reports.run.currency': 'Moneda',
  'reports.run.allCurrencies': 'Todas las monedas',
  'reports.run.submit': 'Generar informe',
  'reports.run.retry': 'Reintentar la misma solicitud',
  'reports.run.created': 'Informe solicitado. Aparecerá abajo en cuanto esté listo.',
  'reports.run.available': 'Datos desde {date}.',
  'reports.invalid.type': 'Elige un informe.',
  'reports.invalid.start': 'Escribe el primer día como AAAA-MM-DD.',
  'reports.invalid.end': 'Escribe el último día como AAAA-MM-DD.',
  'reports.invalid.order': 'El último día no puede ser anterior al primero.',
  'reports.invalid.future': 'El primer día aún no ha llegado.',
  'reports.list': 'Informes generados',
  'reports.empty.title': 'Aún no hay informes',
  'reports.empty.body':
    'Genera un informe arriba; aparecerá aquí con su archivo cuando esté listo.',
  'reports.column.report': 'Informe',
  'reports.column.interval': 'Abarca',
  'reports.column.status': 'Estado',
  'reports.column.created': 'Solicitado',
  'reports.status.pending': 'Generándose',
  'reports.status.succeeded': 'Listo',
  'reports.status.failed': 'Fallido',
  'reports.download': 'Descargar CSV',
  'reports.downloadFailed': 'No se pudo descargar el informe.',
  'reports.downloadWebOnly': 'Descarga el informe desde Orbit en un navegador.',
  'reports.unavailable': 'El archivo ya no está disponible.',
};
