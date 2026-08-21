interface AuthenticatedWebSocketConstructor {
  new (url: string, options: { readonly headers: Record<string, string> }): WebSocket;
}

/**
 * Open a WebSocket with an optional bearer header.
 *
 * Bun 1.4 supports the header-options overload at runtime. When DOM types are
 * loaded, TypeScript intentionally exposes the standard WebSocket constructor
 * instead, so the narrow local constructor models only the Bun overload Beam
 * actually uses.
 */
export function openWebSocket(url: string, token?: string): WebSocket {
  if (!token) return new WebSocket(url);
  // SAFETY: Bun 1.4 implements this overload; the runtime is Bun for all Beam
  // engine entrypoints and the cast narrows only the second-argument shape.
  const BunWebSocket = WebSocket as unknown as AuthenticatedWebSocketConstructor;
  return new BunWebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
}
