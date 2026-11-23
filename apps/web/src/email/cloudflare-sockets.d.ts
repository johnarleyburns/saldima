// SPDX-License-Identifier: AGPL-3.0-only
declare module "cloudflare:sockets" {
  interface Socket {
    readonly opened: Promise<unknown>;
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    startTls(): Socket;
    close(): Promise<void>;
  }
  export function connect(
    address: { hostname: string; port: number },
    options?: { secureTransport?: "off" | "starttls" | "on" },
  ): Socket;
}
