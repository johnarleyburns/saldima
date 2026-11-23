// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { buildMessage } from "./smtp.ts";

const config = {
  host: "smtp.zoho.com",
  port: 587,
  user: "arley@arleyxu.com",
  pass: "secret",
  from: "arley@arleyxu.com",
};

describe("SMTP message", () => {
  it("builds a UTF-8 base64 message and dot-stuffs body lines", () => {
    const message = buildMessage(config, {
      to: "owner@example.test",
      subject: "Saldima — book ready",
      text: "Hello\n.leading dot\n",
    });
    expect(message).toContain("From: Saldima <arley@arleyxu.com>");
    expect(message).toContain("To: <owner@example.test>");
    expect(message).toContain("Subject: =?UTF-8?B?");
    expect(message).toContain("Content-Transfer-Encoding: base64");
    expect(message.endsWith("\r\n.\r\n")).toBe(true);
  });
});
