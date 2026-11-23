// SPDX-License-Identifier: AGPL-3.0-only

import { type SignupInput, tenantHost } from "./signup.ts";

export class TenantExistsError extends Error {
  constructor(readonly host: string) {
    super(`tenant host already exists: ${host}`);
    this.name = "TenantExistsError";
  }
}

export interface ProvisionKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface ProvisionEmail {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

export interface ProvisionDeps {
  readonly kv: ProvisionKv;
  readonly provisionBook: (
    tenantId: string,
    email: string,
  ) => Promise<{ setupToken: string }>;
  readonly email?: ProvisionEmail | undefined;
  readonly domain: string;
  readonly suffix: string;
  readonly scheme?: "http" | "https";
}

export interface ProvisionResult {
  readonly tenantId: string;
  readonly host: string;
  readonly setupUrl: string;
}

function randomTenantId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `tenant-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function provisionTenant(
  deps: ProvisionDeps,
  input: SignupInput,
): Promise<ProvisionResult> {
  const host = tenantHost(input.name, deps.domain, deps.suffix);
  if (await deps.kv.get(`host:${host}`)) throw new TenantExistsError(host);

  const tenantId = randomTenantId();
  const { setupToken } = await deps.provisionBook(tenantId, input.email);
  await deps.kv.put(`host:${host}`, tenantId);
  await deps.kv.put(
    `tenant:${tenantId}`,
    JSON.stringify({ name: input.name, host, plan: input.plan, email: input.email }),
  );

  const scheme = deps.scheme ?? "https";
  const setupUrl = `${scheme}://${host}/app/setup?token=${encodeURIComponent(setupToken)}`;
  if (deps.email) {
    try {
      await deps.email.send({
        to: input.email,
        subject: "Your Saldima book is ready",
        text: [
          `Your Saldima book "${input.name}" is ready.`,
          "",
          "Set your password and two-factor authentication here:",
          setupUrl,
          "",
          "This link expires in 24 hours.",
        ].join("\n"),
      });
    } catch (error) {
      console.error("provision_email_failed", error);
    }
  }
  return { tenantId, host, setupUrl };
}
