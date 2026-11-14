import pg from 'pg';

/**
 * Server-only PostgreSQL access. Returns null when no database is configured,
 * so public reading and simulation keep working without one. Tenant context
 * is set transaction-locally on the same pooled connection as the query and
 * can never leak to the next request.
 */
/** Database rows are validated at each use site; the row type is intentionally loose. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
export type Rows = { readonly rows: readonly Row[]; readonly rowCount: number | null };
export type Tx = { query(sql: string, params?: readonly unknown[]): Promise<Rows> };
export type Database = {
  query(sql: string, params?: readonly unknown[]): Promise<Rows>;
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  inOrganization<T>(organizationId: string, fn: (tx: Tx) => Promise<T>, actorId?: string | null): Promise<T>;
  close(): Promise<void>;
};
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
let instance: Database | null | undefined;

export function createDatabase(connectionString: string, max = 5): Database {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, statement_timeout: 15000, application_name: 'law-machine' });
  pool.on('error', () => { /* idle client errors are reported by the next query */ });
  const transaction = async <T>(fn: (tx: Tx) => Promise<T>, setup?: (tx: Tx) => Promise<void>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx: Tx = { query: (sql, params = []) => client.query(sql, params as unknown[]) as unknown as Promise<Rows> };
      if (setup) await setup(tx);
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  };
  return {
    query: (sql, params = []) => pool.query(sql, params as unknown[]) as unknown as Promise<Rows>,
    transaction: fn => transaction(fn),
    inOrganization: (organizationId, fn, actorId = null) => {
      if (!UUID.test(organizationId) || (actorId !== null && !UUID.test(actorId))) return Promise.reject(Error('TENANT_INVALID'));
      return transaction(fn, async tx => {
        await tx.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
        if (actorId) await tx.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
      });
    },
    close: () => pool.end()
  };
}
export function database(): Database | null {
  if (instance !== undefined) return instance;
  const url = process.env.DATABASE_URL;
  instance = url && /^postgres(ql)?:\/\//.test(url) ? createDatabase(url) : null;
  return instance;
}
