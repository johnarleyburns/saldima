// SPDX-License-Identifier: AGPL-3.0-only

import { FaultInjector } from "../faults.ts";
import type { Conversion, Converter } from "../ports.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Marker-based stand-in for the python3-gnucash converter container. */
export class FakeConverter implements Converter {
  readonly calls: Conversion[] = [];

  constructor(readonly faults = new FaultInjector()) {}

  async convert(input: Conversion): Promise<Uint8Array> {
    this.faults.throwIfPlanned("converter.convert");
    this.calls.push(input);
    const text = decoder.decode(input.bytes);
    const source = `${input.from}:`;
    if (!text.startsWith(source)) {
      throw new Error(`input is not ${input.from}`);
    }
    return encoder.encode(`${input.to}:${text.slice(source.length)}`);
  }
}
