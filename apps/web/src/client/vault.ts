// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Milestone 1 of the zero-knowledge vault (see `docs/architecture/
 * TECHNICAL-DESIGN.md` §8 and issue #88): set up a vault, encrypt the
 * book's existing lossless export entirely in this browser, upload only
 * the ciphertext, then download and decrypt it back to prove the round
 * trip. The server (`apps/web/src/vault-store.ts` and its routes) never
 * sees a passphrase, a recovery code, or an unwrapped key -- only opaque
 * bytes it's handed.
 *
 * This is additive and opt-in: it does not touch the existing
 * server-held-key `book-encryption.ts` path or any existing route.
 */
import {
  DEFAULT_PBKDF2_ITERATIONS,
  decryptPayload,
  deriveKek,
  deriveKekFromRecoveryCode,
  type EnvelopeAad,
  encryptPayload,
  fromBase64,
  generateDek,
  generateRecoveryCode,
  randomBytes,
  toBase64,
  unwrapDek,
  wrapDek,
} from "@saldima/crypto";

const SCHEMA_VERSION = "gnucash-xml-v1";

interface KeyEnvelopeDocument {
  readonly version: 1;
  readonly passphrase: {
    readonly kdf: "PBKDF2-SHA256";
    readonly iterations: number;
    readonly salt: string;
    readonly wrappedDek: string;
  };
  readonly recovery: {
    readonly wrappedDek: string;
  };
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json() as Promise<T>;
}

async function putJson(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
}

async function fetchBytes(path: string): Promise<Uint8Array> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function setUpVault(passphrase: string): Promise<{ recoveryCode: string }> {
  const dek = await generateDek();
  const salt = randomBytes(16);
  const passphraseKek = await deriveKek(passphrase, salt, DEFAULT_PBKDF2_ITERATIONS);
  const wrappedByPassphrase = await wrapDek(dek, passphraseKek);

  const recoveryCode = generateRecoveryCode();
  const recoveryKek = await deriveKekFromRecoveryCode(recoveryCode);
  const wrappedByRecovery = await wrapDek(dek, recoveryKek);

  const document: KeyEnvelopeDocument = {
    version: 1,
    passphrase: {
      kdf: "PBKDF2-SHA256",
      iterations: DEFAULT_PBKDF2_ITERATIONS,
      salt: toBase64(salt),
      wrappedDek: toBase64(wrappedByPassphrase),
    },
    recovery: { wrappedDek: toBase64(wrappedByRecovery) },
  };
  await putJson("/app/vault/keys", document);
  return { recoveryCode };
}

async function unwrapVaultDek(
  secretKind: "passphrase" | "recovery",
  secret: string,
): Promise<CryptoKey> {
  const envelope = await fetchJson<KeyEnvelopeDocument>("/app/vault/keys");
  if (secretKind === "passphrase") {
    const kek = await deriveKek(
      secret,
      fromBase64(envelope.passphrase.salt),
      envelope.passphrase.iterations,
    );
    return unwrapDek(fromBase64(envelope.passphrase.wrappedDek), kek);
  }
  const kek = await deriveKekFromRecoveryCode(secret);
  return unwrapDek(fromBase64(envelope.recovery.wrappedDek), kek);
}

async function createBackup(
  bookId: string,
  dek: CryptoKey,
): Promise<{ snapshotId: string }> {
  const plaintext = await fetchBytes("/app/export/xml");
  const snapshotId = crypto.randomUUID();
  const aad: EnvelopeAad = { bookId, snapshotId, schemaVersion: SCHEMA_VERSION };
  const envelope = await encryptPayload(dek, plaintext, aad);
  await putJson(`/app/vault/snapshots/${snapshotId}`, envelope);
  return { snapshotId };
}

async function verifyBackup(
  bookId: string,
  snapshotId: string,
  dek: CryptoKey,
): Promise<boolean> {
  const bytes = await fetchBytes(`/app/vault/snapshots/${snapshotId}`);
  const envelope = JSON.parse(new TextDecoder().decode(bytes));
  const aad: EnvelopeAad = { bookId, snapshotId, schemaVersion: SCHEMA_VERSION };
  const decrypted = await decryptPayload(dek, envelope, aad);
  const current = await fetchBytes("/app/export/xml");
  return toBase64(decrypted) === toBase64(current);
}

function renderVaultApp(container: HTMLElement, bookId: string): void {
  container.innerHTML = `
<section class="card">
<h2>1. Set up vault</h2>
<label for="vault-setup-passphrase">Vault passphrase</label>
<input id="vault-setup-passphrase" type="password">
<button id="vault-setup-button" type="button">Set up vault</button>
<p id="vault-setup-result"></p>
</section>
<section class="card">
<h2>2. Create encrypted backup now</h2>
<label for="vault-backup-passphrase">Vault passphrase</label>
<input id="vault-backup-passphrase" type="password">
<button id="vault-backup-button" type="button">Create encrypted backup now</button>
<p id="vault-backup-result"></p>
</section>
<section class="card">
<h2>3. Verify my encrypted backup</h2>
<label for="vault-verify-snapshot">Snapshot id</label>
<input id="vault-verify-snapshot" type="text">
<label for="vault-verify-secret-kind">Unlock with</label>
<select id="vault-verify-secret-kind">
<option value="passphrase">Passphrase</option>
<option value="recovery">Recovery code</option>
</select>
<label for="vault-verify-secret">Passphrase or recovery code</label>
<input id="vault-verify-secret" type="text">
<button id="vault-verify-button" type="button">Verify my encrypted backup</button>
<p id="vault-verify-result"></p>
</section>`;

  byId<HTMLButtonElement>("vault-setup-button").addEventListener("click", async () => {
    const result = byId<HTMLParagraphElement>("vault-setup-result");
    try {
      const passphrase = byId<HTMLInputElement>("vault-setup-passphrase").value;
      const { recoveryCode } = await setUpVault(passphrase);
      result.textContent = `Vault set up. Save this recovery code now -- it is shown only once and we cannot recover it for you: ${recoveryCode}`;
      result.setAttribute("data-recovery-code", recoveryCode);
      result.setAttribute("data-vault-setup-result", "ok");
    } catch (error) {
      result.textContent = `Vault setup failed: ${error instanceof Error ? error.message : String(error)}`;
      result.setAttribute("data-vault-setup-result", "error");
    }
  });

  byId<HTMLButtonElement>("vault-backup-button").addEventListener("click", async () => {
    const result = byId<HTMLParagraphElement>("vault-backup-result");
    try {
      const passphrase = byId<HTMLInputElement>("vault-backup-passphrase").value;
      const dek = await unwrapVaultDek("passphrase", passphrase);
      const { snapshotId } = await createBackup(bookId, dek);
      result.textContent = `Backup created. Snapshot id: ${snapshotId}`;
      result.setAttribute("data-snapshot-id", snapshotId);
      result.setAttribute("data-vault-backup-result", "ok");
    } catch (error) {
      result.textContent = `Backup failed: ${error instanceof Error ? error.message : String(error)}`;
      result.setAttribute("data-vault-backup-result", "error");
    }
  });

  byId<HTMLButtonElement>("vault-verify-button").addEventListener("click", async () => {
    const result = byId<HTMLParagraphElement>("vault-verify-result");
    try {
      const snapshotId = byId<HTMLInputElement>("vault-verify-snapshot").value;
      const secretKind = byId<HTMLSelectElement>("vault-verify-secret-kind").value as
        | "passphrase"
        | "recovery";
      const secret = byId<HTMLInputElement>("vault-verify-secret").value;
      const dek = await unwrapVaultDek(secretKind, secret);
      const matches = await verifyBackup(bookId, snapshotId, dek);
      result.textContent = matches
        ? "Match: the decrypted backup is identical to the current export."
        : "Mismatch: the decrypted backup does not match the current export.";
      result.setAttribute("data-verify-result", matches ? "match" : "mismatch");
    } catch (error) {
      result.textContent = `Verification failed: ${error instanceof Error ? error.message : String(error)}`;
      result.setAttribute("data-verify-result", "error");
    }
  });
}

function init(): void {
  const container = document.getElementById("vault-app");
  if (container) {
    const bookId = container.dataset.bookId ?? "";
    renderVaultApp(container, bookId);
  }
  const bundleMarker = document.querySelector<HTMLElement>(
    "[data-vault-bundle-status]",
  );
  if (bundleMarker) bundleMarker.textContent = "loaded";
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
