// SPDX-License-Identifier: AGPL-3.0-only

import { parseCsv } from "./csv.ts";
import { isOfx, parseOfx } from "./ofx.ts";
import { parseQif } from "./qif.ts";
import type { ImportResult, ImportSource } from "./types.ts";

export function detectImportSource(fileName: string, text: string): ImportSource {
  const head = text.slice(0, 4096);
  if (isOfx(head)) return "ofx";
  if (/(^|\n)\s*!Type:/i.test(text)) return "qif";
  if (/(^|\n)\^(\r?\n|$)/.test(text) && /(^|\n)(D\s*\d|T\s*[-+(]?\d)/.test(text)) {
    return "qif";
  }
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  if (extension === "ofx" || extension === "qfx") return "ofx";
  return "csv";
}

export function parseImportFile(fileName: string, text: string): ImportResult {
  const source = detectImportSource(fileName, text);
  if (source === "qif") return parseQif(text);
  if (source === "ofx") return parseOfx(text);
  return parseCsv(text);
}
