import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildMime, type Message } from "./mime.ts";

export interface Transport {
  readonly name: string;
  send(message: Message): Promise<void>;
}

/** Development: every email becomes an .eml file you can open in any mail client. */
export class FileTransport implements Transport {
  readonly name = "file";
  private readonly dir: string;
  private readonly from: string;
  private n = 0;

  constructor(dir: string, from: string) {
    this.dir = dir;
    this.from = from;
  }

  async send(m: Message): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const safe = m.to.replace(/[^a-z0-9@._-]/gi, "_");
    const file = `${new Date().toISOString().replace(/[:.]/g, "-")}-${++this.n}-${safe}.eml`;
    await writeFile(join(this.dir, file), buildMime(this.from, m));
  }
}

/** Tests: keep messages in memory; optionally fail to exercise retries. */
export class MemoryTransport implements Transport {
  readonly name = "memory";
  readonly sent: Message[] = [];
  failNext = 0;

  async send(m: Message): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("simulated delivery failure");
    }
    this.sent.push(m);
  }
}

/** Production: Amazon SES v2, raw MIME so the QR code and invite travel as attachments. */
export class SesTransport implements Transport {
  readonly name = "ses";
  private readonly from: string;
  private readonly region: string;
  private client: unknown;

  constructor(region: string, from: string) {
    this.region = region;
    this.from = from;
  }

  async send(m: Message): Promise<void> {
    const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
    this.client ??= new SESv2Client({ region: this.region });
    const raw = Buffer.from(buildMime(this.from, m));
    await (this.client as InstanceType<typeof SESv2Client>).send(
      new SendEmailCommand({ Content: { Raw: { Data: raw } } }),
    );
  }
}

export function makeTransport(kind: "file" | "ses" | "memory", opts: { dir: string; from: string; region: string }): Transport {
  if (kind === "ses") return new SesTransport(opts.region, opts.from);
  if (kind === "memory") return new MemoryTransport();
  return new FileTransport(opts.dir, opts.from);
}
