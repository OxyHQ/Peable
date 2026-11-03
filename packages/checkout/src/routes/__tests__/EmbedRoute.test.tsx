import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { installCheckoutMocks, mocks, resetMocks } from '../../__tests__/checkoutMocks';
import { sessionFixture } from '../../__tests__/sessionFixture';

installCheckoutMocks();
const { EmbedRoute } = await import('../EmbedRoute');

const SESSION = 'cs_0123456789abcdef01234567';
const SECRET = `${SESSION}_secret_00112233445566778899aabbccddeeff`;
const HOST = 'https://shop.example';

/** The merchant's page that framed us. */
const parentWindow = { postMessage: mock((_message: unknown, _origin: string) => undefined) };
const originalParent = Object.getOwnPropertyDescriptor(window, 'parent');

beforeEach(() => {
  resetMocks();
  parentWindow.postMessage.mockClear();
  Object.defineProperty(window, 'parent', { value: parentWindow, configurable: true });
});
afterEach(() => {
  cleanup();
  if (originalParent) Object.defineProperty(window, 'parent', originalParent);
});

function renderEmbed(fragment: string) {
  render(
    <MemoryRouter initialEntries={[`/embed/${SESSION}#${fragment}`]}>
      <Routes>
        <Route path="/embed/:sessionId" element={<EmbedRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

const fragment = `cs=${encodeURIComponent(SECRET)}&origin=${encodeURIComponent(HOST)}`;

function posted(type: string) {
  return parentWindow.postMessage.mock.calls.filter(
    ([message]) => (message as { type?: string }).type === type,
  );
}

function hostMessage(data: unknown, origin: string, source: unknown) {
  const event = new MessageEvent('message', { data, origin });
  Object.defineProperty(event, 'source', { value: source });
  window.dispatchEvent(event);
}

test("tells the host it is ready, addressed to the host's origin only", async () => {
  mocks.getCheckoutSession.mockImplementation(async () => sessionFixture());
  renderEmbed(fragment);
  expect(await screen.findByText('Notebook')).toBeTruthy();
  const ready = posted('ready');
  expect(ready).toHaveLength(1);
  expect(ready[0]?.[1]).toBe(HOST);
  expect(ready[0]?.[0]).toMatchObject({
    source: 'peable-checkout',
    version: 1,
    type: 'ready',
    session_id: SESSION,
  });
  expect(mocks.getCheckoutSession).toHaveBeenCalledWith(SESSION, SECRET);
});

test('refuses a fragment whose secret is not this session’s', async () => {
  renderEmbed(
    `cs=${encodeURIComponent('cs_ffffffffffffffffffffffff_secret_00112233445566778899aabbccddeeff')}&origin=${encodeURIComponent(HOST)}`,
  );
  expect(
    await screen.findByText('This checkout link is missing required parameters.'),
  ).toBeTruthy();
  expect(mocks.getCheckoutSession).not.toHaveBeenCalled();
});

test('applies a host appearance only from the host origin and the parent window', async () => {
  mocks.getCheckoutSession.mockImplementation(async () => sessionFixture());
  renderEmbed(fragment);
  await screen.findByText('Notebook');
  const shell = () => document.querySelector('.checkout-shell') as HTMLElement;
  const message = {
    source: 'peable-checkout',
    version: 1,
    type: 'appearance',
    session_id: SESSION,
    appearance: { variables: { colorPrimary: '#ff0000' } },
  };

  await act(async () => {
    hostMessage(message, 'https://evil.example', parentWindow);
  });
  expect(shell().style.getPropertyValue('--peable-color-primary')).toBe('#1f6feb');

  await act(async () => {
    hostMessage(message, HOST, {});
  });
  expect(shell().style.getPropertyValue('--peable-color-primary')).toBe('#1f6feb');

  await act(async () => {
    hostMessage(message, HOST, parentWindow);
  });
  await waitFor(() => {
    expect(shell().style.getPropertyValue('--peable-color-primary')).toBe('#ff0000');
  });
});

test('posts complete only once the gateway says so, and never navigates itself', async () => {
  mocks.getCheckoutSession.mockImplementation(async () =>
    sessionFixture({
      status: 'complete',
      payment_status: 'paid',
      success_url: 'https://shop.example/thanks',
    }),
  );
  renderEmbed(fragment);
  await waitFor(() => {
    expect(posted('complete')).toHaveLength(1);
  });
  expect(posted('complete')[0]?.[0]).toMatchObject({
    type: 'complete',
    session_id: SESSION,
    success_url: 'https://shop.example/thanks',
  });
  expect(mocks.redirectTo).not.toHaveBeenCalled();
});

test('posts expired for an expired session', async () => {
  mocks.getCheckoutSession.mockImplementation(async () => sessionFixture({ status: 'expired' }));
  renderEmbed(fragment);
  await waitFor(() => {
    expect(posted('expired')).toHaveLength(1);
  });
});

test('reports a load failure to the host', async () => {
  mocks.getCheckoutSession.mockImplementation(async () => {
    throw new Error('invalid client_secret');
  });
  renderEmbed(fragment);
  await waitFor(() => {
    expect(posted('error')).toHaveLength(1);
  });
  expect(posted('error')[0]?.[0]).toMatchObject({ message: 'invalid client_secret' });
});

test('honours the locale the host passed', async () => {
  mocks.getCheckoutSession.mockImplementation(async () => sessionFixture());
  renderEmbed(`${fragment}&locale=fr`);
  expect(await screen.findByText('Récapitulatif de la commande')).toBeTruthy();
});
