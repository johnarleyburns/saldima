// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { buildVectors, checkVectors } from "./vectors.ts";

describe("golden vectors", () => {
  it("are deterministic", () => {
    expect(buildVectors()).toEqual(buildVectors());
  });

  it("match the committed files", () => {
    expect(checkVectors()).toEqual([]);
  });

  it("cover the contract the iPhone track needs", () => {
    const files = buildVectors();
    const money = JSON.parse(files["money.json"] ?? "{}") as {
      cases?: Array<{ id: string; op: string }>;
    };
    const ids = (money.cases ?? []).map((testCase) => testCase.id);
    expect(ids).toContain("round_tie_to_even_down");
    expect(ids).toContain("round_negative_tie");
    expect(ids).toContain("add_beyond_safe_integer");
    expect(new Set(ids).size).toBe(ids.length);

    const guid = JSON.parse(files["guid.json"] ?? "{}") as {
      valid?: string[];
      invalid?: string[];
    };
    expect(guid.valid).toHaveLength(4);
    expect(guid.invalid).toContain("not-a-guid");

    const accounts = JSON.parse(files["accounts.json"] ?? "{}") as {
      accounts?: Array<{ guid: string; parent: string | null }>;
    };
    const list = accounts.accounts ?? [];
    expect(list).toHaveLength(7);
    expect(list.filter((account) => account.parent === null)).toHaveLength(3);
    expect(new Set(list.map((account) => account.guid)).size).toBe(7);
  });
});
