/** Navigation is product scope, not a claim that every operational API is shipped. */
export const sections = [
  {
    id: 'overview',
    title: 'Overview',
    description: 'Your payment operations, organized around the selected merchant and environment.',
  },
  {
    id: 'payments',
    title: 'Payments',
    description: 'Review amounts, payment status and individual payment records.',
  },
  {
    id: 'customers',
    title: 'Customers',
    description:
      'Customer profiles and payment relationships. A merchant-authorized customer directory is not exposed by the current dashboard API.',
  },
  {
    id: 'subscriptions',
    title: 'Subscriptions',
    description:
      'Recurring plans, renewal status and cancellation workflows. Merchant subscription management is not exposed by the current dashboard API.',
  },
  {
    id: 'invoices',
    title: 'Invoices',
    description:
      'Invoice collection and billing history. Merchant invoice management is not exposed by the current dashboard API.',
  },
  {
    id: 'settlements',
    title: 'Settlements',
    description:
      'Review provider-reported gross, fees and net settlement. These figures require a supported merchant-authorized reporting endpoint.',
  },
  {
    id: 'disputes',
    title: 'Disputes',
    description:
      'Review cases, deadlines and evidence. Service APIs exist; an owner-authorized dashboard case list is still required.',
  },
  {
    id: 'reports',
    title: 'Reports',
    description:
      'Financial reporting across payments and settlements. Totals are not estimated from a partial page of payments.',
  },
  {
    id: 'tax',
    title: 'Tax',
    description:
      'Tax settings, registrations and reports are available in the existing authenticated tax tool.',
  },
  {
    id: 'contributions',
    title: 'Contributions',
    description: 'Manage contribution campaigns using the existing authenticated tool.',
  },
  {
    id: 'developers',
    title: 'Developers',
    description:
      'Connect your integration through Peable APIs and SDKs. Review webhook deliveries and application-scoped configuration.',
  },
  {
    id: 'webhooks',
    title: 'Webhooks',
    description: 'Inspect delivery attempts and outcomes for this application and environment.',
  },
  {
    id: 'keys',
    title: 'API credentials',
    description:
      'Credentials belong to your Oxy application. Credential issuance and rotation are not exposed in Orbit yet.',
  },
  {
    id: 'settings',
    title: 'Settings',
    description:
      'Inspect the merchant identity, webhook endpoint and payment network configuration.',
  },
] as const;
export function sectionInfo(id: string) {
  return sections.find((x) => x.id === id) ?? sections[0];
}
