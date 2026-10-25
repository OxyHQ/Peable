import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServices } from '@oxy.so/core';
import type { PaymentIntent } from '@peable.to/shared-types';
import { Server, type Socket } from 'socket.io';
import { openIntentSubscription } from './intent-subscription';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const token = (account: string, expires = Math.floor(Date.now() / 1000) + 3600) =>
  `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: account, userId: account, sessionId: account, exp: expires })).toString('base64url')}.fixture`;
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Socket condition did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture(accept = true) {
  const http = createServer();
  const server = new Server(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const oxy = new OxyServices({ baseURL, enableCache: false });
  cleanups.push(() => oxy.dispose());
  const sockets: Socket[] = [];
  const handshakes: string[] = [];
  let subscriptions = 0;
  let acknowledge: (() => void) | undefined;
  server.on('connection', (socket) => {
    sockets.push(socket);
    handshakes.push(socket.handshake.auth.token);
    socket.on('subscribe', ({ intentId, clientSecret }, ack) => {
      expect(intentId).toBe('pi_test');
      expect(clientSecret).toBe('pi_test_secret_capability');
      subscriptions++;
      acknowledge = () => ack({ ok: true });
      if (accept) acknowledge();
    });
  });
  const updates: string[] = [];
  const open = (signal?: AbortSignal) =>
    openIntentSubscription(
      oxy,
      baseURL,
      'pi_test',
      'pi_test_secret_capability',
      (intent) => updates.push(intent.id),
      signal,
    );
  const emit = () => server.emit('intent.updated', { id: 'pi_test' } as PaymentIntent);
  return {
    oxy,
    sockets,
    handshakes,
    updates,
    open,
    emit,
    subscriptions: () => subscriptions,
    acknowledge: () => acknowledge?.(),
  };
}

describe('wallet intent socket with the real shared Oxy client', () => {
  test('refreshes before handshake, rejoins after reconnect, closes on account switch and logout', async () => {
    const f = await fixture();
    f.oxy.session.setAccessToken(token('a', 1));
    const fresh = token('a');
    let refreshes = 0;
    f.oxy.http.setAuthRefreshHandler(async () => {
      refreshes++;
      return fresh;
    });
    const subscription = await f.open();
    cleanups.push(() => subscription.unsubscribe());
    expect(refreshes).toBe(1);
    expect(f.handshakes).toEqual([fresh]);
    f.emit();
    await until(() => f.updates.length === 1);
    f.sockets[0]?.conn.close();
    await until(() => f.subscriptions() === 2);
    f.emit();
    await until(() => f.updates.length === 2);
    const nextToken = token('b');
    f.oxy.session.setAccessToken(nextToken);
    await until(() => f.sockets.every((socket) => !socket.connected));
    f.emit();
    expect(f.updates).toHaveLength(2);
    const next = await f.open();
    cleanups.push(() => next.unsubscribe());
    expect(f.handshakes.at(-1)).toBe(nextToken);
    f.oxy.session.clear();
    await until(() => f.sockets.every((socket) => !socket.connected));
  });

  test('switch cancels a pending acknowledgement; a late acknowledgement cannot resurrect it', async () => {
    const f = await fixture(false);
    f.oxy.session.setAccessToken(token('a'));
    const opening = f.open();
    const rejection = opening.catch((error: Error) => error);
    await until(() => f.subscriptions() === 1);
    f.oxy.session.setAccessToken(token('b'));
    expect(await rejection).toMatchObject({ message: 'The Oxy account changed' });
    f.acknowledge();
    await until(() => f.sockets.every((socket) => !socket.connected));
    expect(f.handshakes).toHaveLength(1);
    expect(f.updates).toEqual([]);
  });

  test('unmount cancels a pending token refresh without dialing or keeping a promise alive', async () => {
    const f = await fixture();
    f.oxy.session.setAccessToken(token('a', 1));
    let finish: ((token: string) => void) | undefined;
    f.oxy.http.setAuthRefreshHandler(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const opening = f.open(controller.signal);
    const rejection = opening.catch((error: Error) => error);
    await until(() => Boolean(finish));
    controller.abort();
    expect(await rejection).toMatchObject({ message: 'Payment subscription cancelled' });
    finish?.(token('a'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.handshakes).toEqual([]);
  });
});
