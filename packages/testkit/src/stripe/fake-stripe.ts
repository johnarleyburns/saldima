// SPDX-License-Identifier: AGPL-3.0-only

import { FaultInjector } from "../faults.ts";
import type {
  CheckoutRequest,
  CheckoutSession,
  StripeEvent,
  StripePort,
} from "../ports.ts";

export class FakeStripe implements StripePort {
  readonly sessions: CheckoutRequest[] = [];
  private counter = 0;

  constructor(readonly faults = new FaultInjector()) {}

  async createCheckoutSession(request: CheckoutRequest): Promise<CheckoutSession> {
    this.faults.throwIfPlanned("stripe.createCheckoutSession");
    this.sessions.push(request);
    this.counter += 1;
    return {
      id: `cs_test_${this.counter}`,
      url: `https://checkout.stripe.test/${this.counter}`,
    };
  }

  async verifyWebhook(payload: string, signature: string): Promise<StripeEvent> {
    this.faults.throwIfPlanned("stripe.verifyWebhook");
    if (signature !== "test_signature") {
      throw new Error("invalid signature");
    }
    const parsed: unknown = JSON.parse(payload);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("type" in parsed) ||
      !("sessionId" in parsed) ||
      typeof parsed.type !== "string" ||
      typeof parsed.sessionId !== "string"
    ) {
      throw new Error("invalid event");
    }
    return { type: parsed.type, sessionId: parsed.sessionId };
  }
}
