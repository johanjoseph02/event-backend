/**
 * Real PostgreSQL for the tests, no Docker needed.
 *
 * If TEST_DATABASE_URL is set (CI), that server is used. Otherwise a throwaway cluster is
 * started in a temp directory and removed after the run. Either way a template database
 * is migrated once and every test file clones its own database from it, so files run in
 * parallel without seeing each other's data.
 */
import pg from "pg";
import type { TestProject } from "vitest/node";
import { type LocalPostgres, startLocalPostgres } from "../scripts/local-postgres.ts";
import { migrate } from "../src/db/migrate.ts";

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgTemplate: string;
  }
}

let local: LocalPostgres | undefined;

export async function setup(project: TestProject): Promise<void> {
  let adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    local = await startLocalPostgres();
    adminUrl = local.url;
  }
  const template = `eb_template_${process.pid}`;
  const admin = new pg.Client(adminUrl);
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${template}`);
  await admin.query(`CREATE DATABASE ${template}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: adminUrl.replace(/\/[^/]*$/, `/${template}`) });
  await migrate(pool);
  await pool.end();
  project.provide("pgAdminUrl", adminUrl);
  project.provide("pgTemplate", template);
}

export async function teardown(): Promise<void> {
  await local?.stop();
}
