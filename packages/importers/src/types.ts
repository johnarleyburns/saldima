// SPDX-License-Identifier: AGPL-3.0-only

import type { Money } from "@saldima/gnucash";

export type ImportSource = "qif" | "csv" | "ofx";

export interface ImportSplit {
  readonly category: string;
  readonly amount: Money;
}

export interface ImportRow {
  readonly date: string;
  /** Statement amount in cents. Positive increases the target account. */
  readonly amount: Money;
  readonly payee: string;
  readonly memo: string;
  readonly reference: string;
  readonly category: string;
  readonly splits: readonly ImportSplit[];
}

export interface ImportResult {
  readonly source: ImportSource;
  readonly rows: readonly ImportRow[];
  readonly warnings: readonly string[];
}

export class ImportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportFormatError";
  }
}
