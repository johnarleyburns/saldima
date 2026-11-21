// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { isAllowedLicense } from "./license-scan.mjs";

describe("dependency license allowlist", () => {
  it("allows permissive licenses and OR choices with a permissive branch", () => {
    expect(isAllowedLicense("MIT")).toBe(true);
    expect(isAllowedLicense("Apache-2.0")).toBe(true);
    expect(isAllowedLicense("BSD-3-Clause")).toBe(true);
    expect(isAllowedLicense("MIT OR Apache-2.0")).toBe(true);
    expect(isAllowedLicense("(MIT AND ISC)")).toBe(true);
  });

  it("fails copyleft, including mixed OR expressions", () => {
    expect(isAllowedLicense("GPL-3.0-only")).toBe(false);
    expect(isAllowedLicense("AGPL-3.0-only")).toBe(false);
    expect(isAllowedLicense("MIT OR GPL-3.0")).toBe(false);
    expect(isAllowedLicense("Apache-2.0 AND GPL-2.0")).toBe(false);
  });

  it("fails unknown and unlicensed", () => {
    expect(isAllowedLicense("WTFPL")).toBe(false);
    expect(isAllowedLicense("UNKNOWN")).toBe(false);
    expect(isAllowedLicense("")).toBe(false);
  });
});
