// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  flattenTemplate,
  isTemplateId,
  TEMPLATE_IDS,
  templateById,
} from "./templates.ts";

const ALLOWED = new Set([
  "ASSET",
  "BANK",
  "CASH",
  "CREDIT",
  "LIABILITY",
  "INCOME",
  "EXPENSE",
  "EQUITY",
  "RECEIVABLE",
  "PAYABLE",
]);

describe("book templates", () => {
  it("exposes the three P1 templates", () => {
    expect(TEMPLATE_IDS).toEqual(["personal", "small-business", "insurance-agency"]);
    for (const id of TEMPLATE_IDS) expect(isTemplateId(id)).toBe(true);
    expect(isTemplateId("nope")).toBe(false);
    expect(templateById(undefined).id).toBe("personal");
    expect(templateById("nope").id).toBe("personal");
  });

  it("has unique paths and allowed account types in every template", () => {
    for (const id of TEMPLATE_IDS) {
      const rows = flattenTemplate(templateById(id));
      const paths = rows.map((row) => row.path);
      expect(new Set(paths).size).toBe(paths.length);
      for (const row of rows) {
        expect(ALLOWED.has(row.type)).toBe(true);
        expect(row.name.length).toBeGreaterThan(0);
      }
    }
  });

  it("seeds an agency chart with trust and commission accounts", () => {
    const rows = flattenTemplate(templateById("insurance-agency"));
    const paths = rows.map((row) => row.path);
    expect(paths).toContain("Assets/Trust/Premium Trust");
    expect(paths).toContain("Assets/Trust/Operating");
    expect(paths).toContain("Liabilities/Commissions Payable");
    expect(paths).toContain("Income/Commissions");
    expect(paths).toContain("Expenses/E&O Insurance");
  });

  it("keeps the personal template small and recognisable", () => {
    const paths = flattenTemplate(templateById("personal")).map((row) => row.path);
    expect(paths).toContain("Assets/Bank/Checking");
    expect(paths).toContain("Expenses/Groceries");
    expect(paths).not.toContain("Assets/Trust/Premium Trust");
  });
});
