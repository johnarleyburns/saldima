// SPDX-License-Identifier: AGPL-3.0-only

interface DurableObjectIdLike {
  toString(): string;
}

interface DurableObjectStateLike {
  readonly id: DurableObjectIdLike;
}

/**
 * Placeholder Book object. P0-5 replaces this with the introspected GnuCash
 * schema, import/export and the single-writer guard.
 */
export class Book {
  constructor(private readonly state: DurableObjectStateLike) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      return Response.json({
        ok: true,
        tenant: this.state.id.toString(),
        runtime: "durable-object",
      });
    }
    return new Response("Book placeholder", { status: 200 });
  }
}
