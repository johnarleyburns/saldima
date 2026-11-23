// SPDX-License-Identifier: AGPL-3.0-only

export interface RecordedEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export class InMemoryFaux {
  readonly messages: RecordedEmail[] = [];

  async send(message: RecordedEmail): Promise<void> {
    this.messages.push(message);
  }
}
