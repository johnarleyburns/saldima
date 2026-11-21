// SPDX-License-Identifier: AGPL-3.0-only

import { FaultInjector } from "../faults.ts";
import type { FetchPort } from "../ports.ts";

interface Route {
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export class FakeFetch implements FetchPort {
  readonly calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  private readonly routes = new Map<string, Route>();

  constructor(readonly faults = new FaultInjector()) {}

  route(url: string, status: number, body: string): void {
    this.routes.set(url, { status, body });
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    this.faults.throwIfPlanned("fetch.fetch");
    this.calls.push({ url, init });
    const route = this.routes.get(url);
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body, {
      status: route.status,
      headers: route.headers ?? {},
    });
  }
}
