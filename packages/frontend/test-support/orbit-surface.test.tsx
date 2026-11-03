import { expect, it, mock } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import React, { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
GlobalRegistrator.register();
const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
type Children = { children?: ReactNode };
const Box = ({ children }: Children) => <div>{children}</div>;
const requests: string[] = [];
let resolveOldDetail: ((response: Response) => void) | undefined;
const payment = (id: string) => ({
  object: 'payment_intent',
  id,
  status: 'settled',
  rail: 'card',
  amount: '599',
  currency: 'USD',
  createdAt: '2026-11-03T00:00:00Z',
  updatedAt: '2026-11-03T00:00:00Z',
  txid: null,
  confirmations: 0,
});
const request = mock(async ({ method, url }: { method: string; url: string }) => {
  expect(method).toBe('GET');
  requests.push(url);
  const parsed = new URL(url, 'https://example.test');
  const app = parsed.pathname.includes('/app-b/') ? 'app-b' : 'app-a';
  const environment = parsed.searchParams.get('environment');
  if (parsed.pathname.endsWith('/merchant'))
    return Response.json({
      object: 'merchant',
      id: `merch-${app}`,
      displayName: `Merchant ${app} ${environment}`,
      oxyAppId: app,
      environment,
    });
  if (parsed.pathname.endsWith('/payment_intents/pi_old'))
    return new Promise<Response>((resolve) => {
      resolveOldDetail = resolve;
    });
  if (parsed.pathname.endsWith('/payment_intents'))
    return Response.json({
      object: 'list',
      data: [
        payment(
          app === 'app-b' ? 'pi_b' : parsed.searchParams.has('starting_after') ? 'pi_old' : 'pi_a',
        ),
      ],
      has_more: app === 'app-a' && !parsed.searchParams.has('starting_after'),
    });
  if (parsed.pathname.endsWith('/webhook_deliveries'))
    return Response.json({ object: 'list', data: [], has_more: false });
  throw new Error('Unexpected test route');
});
mock.module('react-native', () => ({ View: Box }));
mock.module('expo-router', () => ({
  Stack: Object.assign(Box, { Screen: () => null }),
  useRouter: () => ({ replace() {}, push() {} }),
}));
mock.module('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: { id: 'viewer-test' }, canUsePrivateApi: true, signIn() {} }),
}));
mock.module('@/services/oxy-services', () => ({
  oxyServices: {
    accounts: {
      list: async () =>
        ['a', 'b'].map((id) => ({
          kind: 'organization',
          accountId: `org-${id}`,
          account: { username: `Organization ${id}` },
          callerMembership: { role: 'owner' },
        })),
    },
    apps: {
      list: async (org: string) => [
        {
          _id: org === 'org-a' ? 'app-a' : 'app-b',
          name: org === 'org-a' ? 'App A' : 'App B',
          status: 'active',
        },
      ],
    },
  },
}));
mock.module('@/services/gateway-client', () => ({
  gateway: { client: { requestAuthenticatedResponse: request } },
}));
mock.module('@/i18n', () => ({ t: (key: string) => key }));
mock.module('@oxy.so/bloom/screen', () => ({
  Screen: ({ children, header }: Children & { header: ReactNode }) => (
    <div>
      {header}
      {children}
    </div>
  ),
  ScreenScrollView: Box,
}));
mock.module('@oxy.so/bloom/page-header', () => ({ PageHeader: () => <header>Orbit</header> }));
mock.module('@oxy.so/bloom/typography', () => ({ Text: Box }));
mock.module('@oxy.so/bloom/button', () => ({
  Button: ({ children, onPress, disabled }: Children & { onPress(): void; disabled?: boolean }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
}));
mock.module('@oxy.so/bloom/grouped-section', () => ({
  GroupedSection: Box,
  GroupedSectionItem: ({
    title,
    description,
    value,
    onPress,
  }: {
    title: string;
    description?: string;
    value?: string;
    onPress?: () => void;
  }) =>
    onPress ? (
      <button type="button" onClick={onPress}>
        {title} {description} {value}
      </button>
    ) : (
      <div>
        {title} {description} {value}
      </div>
    ),
}));
const SelectContext = React.createContext({ value: '', onChange: (_value: string) => {} });
mock.module('@oxy.so/bloom/select', () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: Children & { value: string; onValueChange(value: string): void }) => (
    <SelectContext.Provider value={{ value, onChange: onValueChange }}>
      {children}
    </SelectContext.Provider>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({
    label,
    items,
  }: {
    label: string;
    items: { value: string; label: string }[];
  }) => {
    const state = React.useContext(SelectContext);
    return (
      <select
        aria-label={label}
        value={state.value}
        onChange={(event) => state.onChange(event.target.value)}
      >
        <option value="">Choose</option>
        {items.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    );
  },
  SelectItem: Box,
  SelectItemText: Box,
}));
const SegmentContext = React.createContext((_value: string) => {});
mock.module('@oxy.so/bloom/segmented-control', () => ({
  SegmentedControl: ({
    children,
    onValueChange,
  }: Children & { onValueChange(value: string): void }) => (
    <SegmentContext.Provider value={onValueChange}>{children}</SegmentContext.Provider>
  ),
  SegmentedControlItem: ({ children, value }: Children & { value: string }) => {
    const change = React.useContext(SegmentContext);
    return (
      <button type="button" onClick={() => change(value)}>
        {children}
      </button>
    );
  },
  SegmentedControlItemText: Box,
}));
const { default: OrbitScreen } = await import('../app/orbit');
it('navigates real authenticated views with isolated scope, paging and stale detail protection', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <OrbitScreen />
    </QueryClientProvider>,
  );
  try {
    fireEvent.change(await view.findByLabelText('orbit.organization'), {
      target: { value: 'org-a' },
    });
    fireEvent.change(await view.findByLabelText('orbit.application'), {
      target: { value: 'app-a' },
    });
    await view.findByText(/Merchant app-a development/);
    await view.findByRole('button', { name: /pi_a/ });
    fireEvent.click(view.getByRole('button', { name: 'orbit.next' }));
    fireEvent.click(await view.findByRole('button', { name: /pi_old/ }));
    await waitFor(() => expect(resolveOldDetail).toBeDefined());
    fireEvent.change(view.getByLabelText('orbit.environment'), { target: { value: 'production' } });
    await view.findByText(/Merchant app-a production/);
    expect(view.queryByRole('button', { name: 'orbit.closeDetail' })).toBeNull();
    expect(requests.some((url) => url.includes('starting_after=pi_a'))).toBe(true);
    fireEvent.change(view.getByLabelText('orbit.organization'), { target: { value: 'org-b' } });
    await waitFor(() => expect(view.queryByText(/Merchant app-a/)).toBeNull());
    fireEvent.change(await view.findByLabelText('orbit.application'), {
      target: { value: 'app-b' },
    });
    await view.findByText(/Merchant app-b production/);
    await view.findByRole('button', { name: /pi_b/ });
    resolveOldDetail?.(Response.json(payment('pi_old')));
    await waitFor(() => expect(view.queryByText(/pi_old/)).toBeNull());
    expect(view.getByRole('button', { name: 'orbit.previous' }).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.click(view.getByRole('button', { name: 'orbit.webhooks' }));
    await view.findByText('orbit.empty.webhooks');
    expect(
      requests
        .filter((url) => url.includes('/app-b/'))
        .every((url) => url.includes('environment=production') && !url.includes('starting_after')),
    ).toBe(true);
  } finally {
    cleanup();
    client.clear();
  }
});
