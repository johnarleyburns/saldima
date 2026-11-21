// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { cloudflareKv } from "../../../../apps/web/src/ports/cloudflare-kv.ts";
import { cloudflareR2 } from "../../../../apps/web/src/ports/cloudflare-r2.ts";
import { keyValueContract, objectStoreContract } from "../contracts.ts";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    KV: Parameters<typeof cloudflareKv>[0];
    R2: Parameters<typeof cloudflareR2>[0];
  }
}

keyValueContract("Cloudflare KV (workerd)", () => cloudflareKv(env.KV));
objectStoreContract("Cloudflare R2 (workerd)", () => cloudflareR2(env.R2));

describe("workerd bindings are real", () => {
  it("persists across adapter instances", async () => {
    await cloudflareKv(env.KV).put("runtime/persist", "yes");
    expect(await cloudflareKv(env.KV).get("runtime/persist")).toBe("yes");
    await cloudflareKv(env.KV).delete("runtime/persist");
  });

  it("reports a stable R2 etag", async () => {
    const store = cloudflareR2(env.R2);
    const first = await store.put("runtime/etag", new Uint8Array([1, 2, 3]));
    const second = await store.get("runtime/etag");
    expect(second?.etag).toBe(first.etag);
    await store.delete("runtime/etag");
  });
});
