/**
 * Platform-specific TCP socket providers for P2P connections.
 *
 * - NativeSocketProvider: iOS/Android via react-native-tcp-socket
 * - ElectronSocketProvider: Electron via IPC preload bridge
 * - FallbackSocketProvider: Web without Electron (throws, TCP unavailable)
 *
 * Uses conditional require to avoid web bundling issues with native modules.
 */

import { Platform } from 'react-native';
import type { SocketConnection, SocketProvider } from './peer';

// ---------------------------------------------------------------------------
// Electron IPC bridge type
//
// Mirrors the contract exposed by electron/preload.js. The `connect` call is
// asynchronous — it resolves to a connection ID once the underlying TCP
// socket is established in the main process. The `onData` / `onClose` /
// `onError` listeners are GLOBAL (they fire for every active connection),
// so consumers must filter by connection ID and unsubscribe on teardown.
// ---------------------------------------------------------------------------

type Unsubscribe = () => void;

interface ElectronP2PBridge {
  connect(host: string, port: number): Promise<string>;
  send(connectionId: string, data: Uint8Array): Promise<void>;
  disconnect(connectionId: string): Promise<void>;
  onData(callback: (connectionId: string, data: Uint8Array) => void): Unsubscribe;
  onClose(callback: (connectionId: string) => void): Unsubscribe;
  onError(callback: (connectionId: string, error: string) => void): Unsubscribe;
}

interface ElectronAPI {
  p2p: ElectronP2PBridge;
}

// ---------------------------------------------------------------------------
// Native TCP socket types (react-native-tcp-socket)
// Defined here to avoid requiring type declarations for the native module.
// ---------------------------------------------------------------------------

interface NativeTcpSocket {
  on(event: 'data', callback: (data: Uint8Array) => void): void;
  on(event: 'close', callback: () => void): void;
  on(event: 'error', callback: (err: Error) => void): void;
  write(data: Uint8Array | Buffer): void;
  destroy(): void;
}

interface NativeTcpModule {
  createConnection(options: { host: string; port: number }, callback: () => void): NativeTcpSocket;
}

// ---------------------------------------------------------------------------
// Window with Electron API
// ---------------------------------------------------------------------------

function getElectronAPI(): ElectronAPI | undefined {
  if (typeof window === 'undefined') return undefined;
  const win = window as unknown as Record<string, unknown>;
  const api = win.electronAPI;
  if (api == null) return undefined;
  return api as ElectronAPI;
}

// ---------------------------------------------------------------------------
// NativeSocketProvider (iOS / Android)
// ---------------------------------------------------------------------------

class NativeSocketProvider implements SocketProvider {
  connect(host: string, port: number): SocketConnection {
    const TcpSocket = require('react-native-tcp-socket') as NativeTcpModule;

    let connectCallback: (() => void) | undefined;

    const socket = TcpSocket.createConnection({ host, port }, () => {
      if (connectCallback) {
        connectCallback();
      }
    });

    return {
      onConnect: (cb: () => void) => {
        connectCallback = cb;
      },
      onData: (cb: (data: Uint8Array) => void) => {
        socket.on('data', (data: Uint8Array) => {
          cb(new Uint8Array(data));
        });
      },
      onClose: (cb: () => void) => {
        socket.on('close', cb);
      },
      onError: (cb: (err: Error) => void) => {
        socket.on('error', cb);
      },
      write: (data: Uint8Array) => {
        socket.write(data);
      },
      destroy: () => {
        socket.destroy();
      },
    };
  }
}

// ---------------------------------------------------------------------------
// ElectronSocketProvider (Desktop via IPC bridge)
//
// The Electron preload bridge is Promise-based and uses a single set of
// global event listeners per event kind. This provider:
//
//   1. Kicks off `p2p.connect(...)` which resolves to a connection ID.
//   2. Subscribes to the global `onData` / `onClose` / `onError` listeners
//      and filters them by the connection ID for this socket instance.
//   3. Defers the `onConnect` callback until the Promise resolves, and
//      queues any `write` calls made before the connection is established.
//   4. On `destroy`, unsubscribes the listeners and disconnects the socket
//      in the main process.
// ---------------------------------------------------------------------------

class ElectronSocketProvider implements SocketProvider {
  connect(host: string, port: number): SocketConnection {
    const electronAPI = getElectronAPI();
    if (!electronAPI?.p2p) {
      throw new Error(
        'Electron P2P bridge not available. Ensure preload.js exposes window.electronAPI.p2p.',
      );
    }

    const p2p = electronAPI.p2p;

    let connectionId: string | null = null;
    let destroyed = false;

    let connectCb: (() => void) | undefined;
    let dataCb: ((data: Uint8Array) => void) | undefined;
    let closeCb: (() => void) | undefined;
    let errorCb: ((err: Error) => void) | undefined;

    // Subscribe eagerly so no event is missed between the Promise resolving
    // and the consumer wiring up its handlers. Each listener filters by the
    // connection ID assigned once `p2p.connect` resolves.
    const unsubscribeData = p2p.onData((id: string, data: Uint8Array) => {
      if (id === connectionId && dataCb) {
        dataCb(data);
      }
    });
    const unsubscribeClose = p2p.onClose((id: string) => {
      if (id === connectionId && closeCb) {
        closeCb();
      }
    });
    const unsubscribeError = p2p.onError((id: string, message: string) => {
      if (id === connectionId && errorCb) {
        errorCb(new Error(message));
      }
    });

    const connectPromise = p2p
      .connect(host, port)
      .then((id: string) => {
        if (destroyed) {
          // The caller tore the socket down before the TCP connection was
          // established — disconnect immediately and swallow the id.
          void p2p.disconnect(id);
          return;
        }
        connectionId = id;
        if (connectCb) {
          connectCb();
        }
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (errorCb) {
          errorCb(error);
        }
      });

    const teardownListeners = (): void => {
      unsubscribeData();
      unsubscribeClose();
      unsubscribeError();
    };

    return {
      onConnect: (cb: () => void) => {
        connectCb = cb;
      },
      onData: (cb: (data: Uint8Array) => void) => {
        dataCb = cb;
      },
      onClose: (cb: () => void) => {
        closeCb = cb;
      },
      onError: (cb: (err: Error) => void) => {
        errorCb = cb;
      },
      write: (data: Uint8Array) => {
        if (destroyed) {
          return;
        }
        if (connectionId !== null) {
          void p2p.send(connectionId, data).catch((err: unknown) => {
            if (errorCb) {
              errorCb(err instanceof Error ? err : new Error(String(err)));
            }
          });
          return;
        }
        // Not yet connected — wait for the connect Promise, then send.
        void connectPromise.then(() => {
          if (destroyed || connectionId === null) {
            return;
          }
          void p2p.send(connectionId, data).catch((err: unknown) => {
            if (errorCb) {
              errorCb(err instanceof Error ? err : new Error(String(err)));
            }
          });
        });
      },
      destroy: () => {
        if (destroyed) {
          return;
        }
        destroyed = true;
        teardownListeners();
        if (connectionId !== null) {
          void p2p.disconnect(connectionId);
        }
      },
    };
  }
}

// ---------------------------------------------------------------------------
// FallbackSocketProvider (Web without Electron)
// ---------------------------------------------------------------------------

class FallbackSocketProvider implements SocketProvider {
  connect(_host: string, _port: number): never {
    throw new Error(
      'TCP connections are not available in web browsers. ' +
        'Run Peable as a native app (iOS/Android) or via Electron for P2P connectivity.',
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the appropriate SocketProvider for the current platform.
 *
 * - iOS/Android: NativeSocketProvider (react-native-tcp-socket)
 * - Web + Electron: ElectronSocketProvider (IPC bridge)
 * - Web (browser): FallbackSocketProvider (throws on connect)
 */
export function createSocketProvider(): SocketProvider {
  if (Platform.OS === 'web') {
    if (getElectronAPI() != null) {
      return new ElectronSocketProvider();
    }
    return new FallbackSocketProvider();
  }
  return new NativeSocketProvider();
}
