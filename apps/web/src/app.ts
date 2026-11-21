// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";

import type { KvNamespaceLike } from "./ports/cloudflare-kv.ts";
import type { R2BucketLike } from "./ports/cloudflare-r2.ts";

export interface AppBindings {
  KV: Pick<KvNamespaceLike, "get" | "put">;
  R2: R2BucketLike;
  BOOK: unknown;
}

interface AppVariables {
  tenantId: string | null;
  host: string;
}

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

const APEX_HOSTS = new Set(["localhost", "saldima.test", "www.saldima.test"]);
const LOCAL_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function hostOf(request: Request): string {
  return new URL(request.url).hostname.toLowerCase();
}

async function tenantFor(host: string, kv: AppBindings["KV"]): Promise<string | null> {
  const stored = await kv.get(`host:${host}`);
  if (stored) return stored;

  if (host.endsWith(".localhost")) {
    const subdomain = host.slice(0, -".localhost".length);
    if (subdomain === "" || subdomain.includes(".")) return null;
    if (!LOCAL_SUBDOMAIN.test(subdomain)) return null;
    const tenantId = `tenant-${subdomain}`;
    await kv.put(`host:${host}`, tenantId);
    return tenantId;
  }
  return null;
}

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const host = hostOf(c.req.raw);
    c.set("host", host);
    if (APEX_HOSTS.has(host)) {
      c.set("tenantId", null);
      await next();
      return;
    }
    const tenantId = await tenantFor(host, c.env.KV);
    if (!tenantId) {
      return c.text("No book at this address", 404);
    }
    c.set("tenantId", tenantId);
    await next();
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      tenant: c.get("tenantId"),
      host: c.get("host"),
    }),
  );

  app.get("/", (c) => {
    const tenantId = c.get("tenantId");
    if (!tenantId) {
      return c.html(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Saldima</title></head>
<body><main><h1>Saldima</h1><p>Hosted, GnuCash-compatible accounting. Compatible with GnuCash.</p></main></body>
</html>`);
    }
    return c.html(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Saldima</title></head>
<body data-tenant="${escapeHtml(tenantId)}"><main><h1>Saldima</h1><p>Book: ${escapeHtml(tenantId)}</p><p><a href="/health">Health</a></p></main></body>
</html>`);
  });

  app.get("/app", (c) => c.text(`Book ${c.get("tenantId") ?? ""}`));

  return app;
}
