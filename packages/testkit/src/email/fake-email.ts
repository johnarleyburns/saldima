// SPDX-License-Identifier: AGPL-3.0-only

import { FaultInjector } from "../faults.ts";
import type { EmailMessage, EmailPort } from "../ports.ts";

export class FakeEmail implements EmailPort {
  readonly messages: EmailMessage[] = [];

  constructor(readonly faults = new FaultInjector()) {}

  async send(message: EmailMessage): Promise<void> {
    this.faults.throwIfPlanned("email.send");
    this.messages.push(message);
  }
}
