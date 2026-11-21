// SPDX-License-Identifier: AGPL-3.0-only

/** A GnuCash GUID: 32 lowercase hex characters. Tightened to a branded type in P0-4. */
export type Guid = string;

/** Every non-deterministic or async dependency enters through this object. */
export interface Ports {
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly ids: IdGenerator;
  readonly random: Random;
  readonly r2: ObjectStore;
  readonly kv: KeyValueStore;
  readonly book: BookStub;
  readonly converter: Converter;
  readonly stripe: StripePort;
  readonly email: EmailPort;
  readonly fetch: FetchPort;
}

export interface Clock {
  now(): Date;
}

export interface CancelHandle {
  cancel(): void;
}

export interface Scheduler {
  /** Run `task` after `delayMs`. The manual scheduler never uses real timers. */
  schedule(delayMs: number, task: () => void): CancelHandle;
}

export interface IdGenerator {
  next(): Guid;
}

export interface Random {
  bytes(length: number): Uint8Array;
}

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly etag: string;
  readonly contentType: string | undefined;
}

export interface ObjectStore {
  put(key: string, bytes: Uint8Array, contentType?: string): Promise<StoredObject>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  /** Keys under `prefix`, sorted ascending. */
  list(prefix: string): Promise<string[]>;
}

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys under `prefix`, sorted ascending. */
  list(prefix: string): Promise<string[]>;
}

export interface BookRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly body?: Uint8Array;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface BookResponse {
  readonly status: number;
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
}

/** A tenant Book Durable Object, reached the way the Worker reaches it. */
export interface BookStub {
  request(request: BookRequest): Promise<BookResponse>;
}

export interface Conversion {
  readonly from: "xml" | "sqlite";
  readonly to: "xml" | "sqlite";
  readonly bytes: Uint8Array;
}

export interface Converter {
  convert(input: Conversion): Promise<Uint8Array>;
}

export interface CheckoutRequest {
  readonly tenantId: string;
  readonly email: string;
  readonly plan: "monthly" | "yearly";
  readonly successUrl: string;
  readonly cancelUrl: string;
}

export interface CheckoutSession {
  readonly id: string;
  readonly url: string;
}

export interface StripeEvent {
  readonly type: string;
  readonly sessionId: string;
}

export interface StripePort {
  createCheckoutSession(request: CheckoutRequest): Promise<CheckoutSession>;
  verifyWebhook(payload: string, signature: string): Promise<StripeEvent>;
}

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface EmailPort {
  send(message: EmailMessage): Promise<void>;
}

export interface FetchPort {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}
