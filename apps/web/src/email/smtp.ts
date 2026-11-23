// SPDX-License-Identifier: AGPL-3.0-only
import { connect } from "cloudflare:sockets";

import { now } from "../time/system-clock.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
}

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

function base64Utf8(value: string): string {
  let binary = "";
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function addressList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.replace(/[\r\n<>]/g, "").trim())
    .filter(Boolean);
}

export function buildMessage(config: SmtpConfig, message: EmailMessage): string {
  const domain = config.from.split("@")[1] ?? "localhost";
  const body = (base64Utf8(message.text).match(/.{1,76}/g) ?? []).join("\r\n");
  const headers = [
    `From: Saldima <${config.from}>`,
    `To: ${addressList(message.to)
      .map((address) => `<${address}>`)
      .join(", ")}`,
    `Subject: =?UTF-8?B?${base64Utf8(message.subject)}?=`,
    `Date: ${now().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
    "",
    body,
  ];
  const payload = `${headers.join("\r\n")}\r\n`
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
  return `${payload}\r\n.\r\n`;
}

interface Channel {
  reply(): Promise<{ code: number; text: string }>;
  write(data: string): Promise<void>;
  upgrade(): Promise<Channel>;
  close(): Promise<void>;
}

function makeChannel(socket: ReturnType<typeof connect>): Channel {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  let buffer = "";
  let ended = false;

  async function readLine(): Promise<string> {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        const line = buffer.slice(0, newline + 1);
        buffer = buffer.slice(newline + 1);
        return line;
      }
      if (ended) {
        if (buffer) {
          const line = buffer;
          buffer = "";
          return line;
        }
        throw new Error("SMTP connection closed unexpectedly");
      }
      const { value, done } = await reader.read();
      if (done) {
        ended = true;
        continue;
      }
      buffer += decoder.decode(value, { stream: true });
    }
  }

  return {
    async reply() {
      const lines: string[] = [];
      for (;;) {
        const line = (await readLine()).replace(/\r?\n$/, "");
        const match = /^(\d{3})([ -])/.exec(line);
        if (!match) throw new Error(`Malformed SMTP reply: ${line.slice(0, 120)}`);
        lines.push(line);
        if (match[2] === " ") return { code: Number(match[1]), text: lines.join("\n") };
        if (lines.length > 200) throw new Error("SMTP reply too long");
      }
    },
    async write(data) {
      await writer.write(encoder.encode(data));
    },
    async upgrade() {
      try {
        reader.releaseLock();
        writer.releaseLock();
      } catch {
        // already released
      }
      return makeChannel(socket.startTls());
    },
    async close() {
      try {
        reader.releaseLock();
        writer.releaseLock();
      } catch {
        // already released
      }
      try {
        await socket.close();
      } catch {
        // noop
      }
    },
  };
}

function expectCode(reply: { code: number }, codes: number[], stage: string): void {
  if (!codes.includes(reply.code)) {
    throw new Error(`SMTP ${stage} failed with ${reply.code}`);
  }
}

export async function sendSmtpEmail(
  config: SmtpConfig,
  message: EmailMessage,
  timeoutMs = 15_000,
): Promise<void> {
  const recipients = addressList(message.to);
  if (recipients.length === 0) throw new Error("no recipients");
  const socket = connect(
    { hostname: config.host, port: config.port },
    { secureTransport: "starttls" },
  );
  let channel: Channel | undefined;
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("SMTP timeout")), timeoutMs);
  });
  try {
    await Promise.race([socket.opened, timeout]);
    channel = makeChannel(socket);
    expectCode(await channel.reply(), [220], "greeting");
    await channel.write("EHLO saldima\r\n");
    expectCode(await channel.reply(), [250], "EHLO");
    await channel.write("STARTTLS\r\n");
    expectCode(await channel.reply(), [220], "STARTTLS");
    channel = await channel.upgrade();
    await channel.write("EHLO saldima\r\n");
    expectCode(await channel.reply(), [250], "EHLO after STARTTLS");
    await channel.write("AUTH LOGIN\r\n");
    expectCode(await channel.reply(), [334], "AUTH LOGIN");
    await channel.write(`${base64Utf8(config.user)}\r\n`);
    expectCode(await channel.reply(), [334], "AUTH user");
    await channel.write(`${base64Utf8(config.pass)}\r\n`);
    expectCode(await channel.reply(), [235], "AUTH password");
    await channel.write(`MAIL FROM:<${config.from}>\r\n`);
    expectCode(await channel.reply(), [250], "MAIL FROM");
    for (const recipient of recipients) {
      await channel.write(`RCPT TO:<${recipient}>\r\n`);
      expectCode(await channel.reply(), [250, 251], "RCPT TO");
    }
    await channel.write("DATA\r\n");
    expectCode(await channel.reply(), [354], "DATA");
    await channel.write(buildMessage(config, message));
    expectCode(await channel.reply(), [250], "message body");
    await channel.write("QUIT\r\n");
  } finally {
    if (channel) await channel.close();
    else {
      try {
        await socket.close();
      } catch {
        // noop
      }
    }
  }
}
