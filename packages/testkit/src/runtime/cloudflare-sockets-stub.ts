// SPDX-License-Identifier: AGPL-3.0-only

/** Node unit tests never open a socket; real workerd tests use the real module. */
export function connect(): never {
  throw new Error("cloudflare:sockets is only available in workerd");
}
