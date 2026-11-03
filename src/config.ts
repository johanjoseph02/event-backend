import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(3000),
  BASE_URL: z.string().url().default("http://localhost:3000"),
  // 32+ random bytes, hex or base64. Encrypts ticket signing keys and signs magic links.
  APP_SECRET: z.string().min(32),
  EMAIL_TRANSPORT: z.enum(["file", "ses", "memory"]).default("file"),
  EMAIL_FROM: z.string().default("Events <events@example.org>"),
  EMAIL_OUTBOX_DIR: z.string().default("outbox"),
  AWS_REGION: z.string().default("ap-south-1"),
  TRUST_PROXY: z.coerce.boolean().default(false),
  REGISTRATION_RATE_PER_MIN: z.coerce.number().int().positive().default(10),
  RUN_WORKER: z.coerce.boolean().default(true),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid configuration:\n  ${problems.join("\n  ")}`);
  }
  return parsed.data;
}
