import { randomBytes } from "node:crypto";

export interface Attachment {
  filename: string;
  contentType: string;
  content: Buffer;
  cid?: string; // inline, referenced from the HTML as cid:<cid>
}

export interface Message {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments: Attachment[];
}

const wrap = (b64: string) => b64.replace(/.{1,76}/g, "$&\r\n");

/** RFC 2047 encoded-word for non-ASCII header values. */
function header(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
}

/** A complete RFC 5322 message: alternative text/HTML body plus attachments. */
export function buildMime(from: string, m: Message, date = new Date()): string {
  const mixed = `mixed_${randomBytes(12).toString("hex")}`;
  const alt = `alt_${randomBytes(12).toString("hex")}`;
  const lines = [
    `From: ${from}`,
    `To: ${m.to}`,
    `Subject: ${header(m.subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${randomBytes(16).toString("hex")}@event-backend>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(Buffer.from(m.text).toString("base64")),
    `--${alt}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(Buffer.from(m.html).toString("base64")),
    `--${alt}--`,
  ];
  for (const a of m.attachments) {
    lines.push(
      `--${mixed}`,
      `Content-Type: ${a.contentType}; name="${a.filename}"`,
      "Content-Transfer-Encoding: base64",
      a.cid
        ? `Content-Disposition: inline; filename="${a.filename}"\r\nContent-ID: <${a.cid}>`
        : `Content-Disposition: attachment; filename="${a.filename}"`,
      "",
      wrap(a.content.toString("base64")),
    );
  }
  lines.push(`--${mixed}--`, "");
  return lines.join("\r\n");
}
