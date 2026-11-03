import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString: url, max });
  pool.on("error", (err) => console.error(JSON.stringify({ level: "error", msg: "pg pool", err: err.message })));
  return pool;
}

/** Run ``fn`` in a transaction; roll back on any error. */
export async function transaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
