// SPDX-License-Identifier: AGPL-3.0-only

import { FakeBook } from "./book/fake-book.ts";
import { FakeConverter } from "./converter/fake-converter.ts";
import { FakeEmail } from "./email/fake-email.ts";
import { FaultInjector } from "./faults.ts";
import { FakeFetch } from "./fetch/fake-fetch.ts";
import { SeededIdGenerator } from "./ids/seeded-id-generator.ts";
import type { Ports } from "./ports.ts";
import { CryptoRandom } from "./random/crypto-random.ts";
import { SeededRandom } from "./random/seeded-random.ts";
import { InMemoryKeyValueStore } from "./storage/memory-kv.ts";
import { InMemoryObjectStore } from "./storage/memory-object-store.ts";
import { FakeStripe } from "./stripe/fake-stripe.ts";
import { ManualClock } from "./time/manual-clock.ts";
import { ManualScheduler } from "./time/manual-scheduler.ts";

export interface FakePorts extends Ports {
  readonly faults: FaultInjector;
  readonly clock: ManualClock;
  readonly scheduler: ManualScheduler;
  readonly kv: InMemoryKeyValueStore;
  readonly r2: InMemoryObjectStore;
  readonly book: FakeBook;
  readonly converter: FakeConverter;
  readonly stripe: FakeStripe;
  readonly email: FakeEmail;
  readonly fetch: FakeFetch;
}

export function createFakePorts(overrides: Partial<Ports> = {}): FakePorts {
  const faults = new FaultInjector();
  const base: FakePorts = {
    faults,
    clock: new ManualClock(),
    scheduler: new ManualScheduler(),
    ids: new SeededIdGenerator(),
    random: new SeededRandom() as Ports["random"],
    r2: new InMemoryObjectStore(faults),
    kv: new InMemoryKeyValueStore(faults),
    book: new FakeBook(faults),
    converter: new FakeConverter(faults),
    stripe: new FakeStripe(faults),
    email: new FakeEmail(faults),
    fetch: new FakeFetch(faults),
  };
  return { ...base, ...overrides } as FakePorts;
}

export const cryptoRandom = (): CryptoRandom => new CryptoRandom();
