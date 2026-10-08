// Aplica en orden alfabético los archivos de migrations/*.sql que aún no se han aplicado.
// Uso: tsx scripts/migrate.ts [DATABASE_URL]   (sin argumento usa la variable DATABASE_URL o el valor por defecto)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const DEFAULT_URL = 'postgres://exchange:exchange@localhost:5433/exchange';
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

export async function migrate(databaseUrl: string): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const done = new Set(
      (await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename),
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

      // Cada archivo va en su propia transacción: o se aplica completo y queda registrado, o no queda nada.
      // query() sin parámetros usa el protocolo simple, que admite varias sentencias en un mismo string.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migración ${file} falló: ${(err as Error).message}`);
      }
      applied.push(file);
    }
  } finally {
    await client.end();
  }
  return applied;
}

// Solo se ejecuta al llamarlo como script; las pruebas importan migrate() sin disparar esto.
if (require.main === module) {
  const url = process.argv[2] ?? process.env.DATABASE_URL ?? DEFAULT_URL;
  migrate(url)
    .then((applied) => {
      console.log(applied.length ? `Migraciones aplicadas: ${applied.join(', ')}` : 'Base de datos al día.');
    })
    .catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
}
