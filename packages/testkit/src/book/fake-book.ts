// SPDX-License-Identifier: AGPL-3.0-only

import { FaultInjector } from "../faults.ts";
import type { BookRequest, BookResponse, BookStub } from "../ports.ts";

const encoder = new TextEncoder();

function json(status: number, value: unknown): BookResponse {
  return {
    status,
    body: encoder.encode(JSON.stringify(value)),
    headers: { "content-type": "application/json" },
  };
}

/**
 * Canned Book for tests. The real Book contract suite runs against this shape
 * and against the Durable Object in workerd (P0-5).
 */
export class FakeBook implements BookStub {
  constructor(readonly faults = new FaultInjector()) {}

  async request(request: BookRequest): Promise<BookResponse> {
    this.faults.throwIfPlanned("book.request");
    if (request.method === "GET" && request.path === "/health") {
      return json(200, { ok: true });
    }
    if (request.method === "POST" && request.path === "/echo") {
      return {
        status: 200,
        body: request.body?.slice() ?? new Uint8Array(),
        headers: { "content-type": "application/octet-stream" },
      };
    }
    return json(404, { error: "not found" });
  }
}
