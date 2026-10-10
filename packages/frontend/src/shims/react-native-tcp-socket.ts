/**
 * Web shim for react-native-tcp-socket.
 *
 * This file is resolved instead of the real native module when bundling for web.
 * TCP sockets are not available in browsers - the FallbackSocketProvider handles
 * this gracefully at runtime.
 */

// Re-export an empty object - the NativeSocketProvider is never instantiated on web
export default {
  createConnection() {
    throw new Error('TCP sockets are not available on web platform');
  },
};
