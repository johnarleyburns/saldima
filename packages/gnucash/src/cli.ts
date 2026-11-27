// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stdin/stdout NDJSON transport for the accounting bridge: reads one
 * JSON request per line, writes exactly one JSON response per line (in
 * order) to stdout, and exits cleanly on `{"op":"exit"}` or stdin EOF.
 * All behaviour lives in `cli-bridge.ts`'s `handleRequest`; this file is
 * a thin, behaviourless loop and carries no tests of its own.
 *
 * Run with `pnpm accounting-bridge` (see `package.json`).
 */

import { createInterface } from "node:readline";
import { handleRequest } from "./cli-bridge.ts";
import type { Ledger } from "./ledger.ts";

function main(): void {
  let state: Ledger | undefined;
  let pendingWrites = 0;
  let inputClosed = false;

  function maybeExit(): void {
    if (inputClosed && pendingWrites === 0) process.exit(0);
  }

  function respond(response: unknown): void {
    pendingWrites += 1;
    process.stdout.write(`${JSON.stringify(response)}\n`, () => {
      pendingWrites -= 1;
      maybeExit();
    });
  }

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      respond({
        ok: false,
        error: {
          code: "INVALID_JSON",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }

    const { response, nextState } = handleRequest(state, parsed);
    state = nextState;
    respond(response);

    if (isRecord(parsed) && parsed.op === "exit") {
      rl.close();
    }
  });

  rl.on("close", () => {
    inputClosed = true;
    maybeExit();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

main();
