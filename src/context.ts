import type { Config } from "./config.ts";
import { masterKey } from "./crypto.ts";
import type { Db } from "./db/pool.ts";
import type { Transport } from "./email/transports.ts";

/** What every part of the app needs, passed explicitly instead of imported as globals. */
export interface Ctx {
  db: Db;
  config: Config;
  master: Buffer;
  transport: Transport;
  now: () => Date;
}

export function makeCtx(db: Db, config: Config, transport: Transport, now: () => Date = () => new Date()): Ctx {
  return { db, config, master: masterKey(config.APP_SECRET), transport, now };
}
