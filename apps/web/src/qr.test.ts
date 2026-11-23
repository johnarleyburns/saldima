// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { totpQrSvg } from "./qr.ts";

describe("TOTP QR code", () => {
  const uri =
    "otpauth://totp/Saldima:owner@example.test?secret=JBSWY3DPEHPK3PXP&issuer=Saldima";

  it("renders an inline scalable SVG", () => {
    const svg = totpQrSvg(uri);
    expect(svg).toContain("<svg");
    expect(svg).toContain("viewBox");
    expect(svg).toContain("preserveAspectRatio");
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("href=");
  });

  it("encodes different URIs differently", () => {
    expect(totpQrSvg(uri)).not.toBe(totpQrSvg(`${uri}&x=1`));
  });
});
