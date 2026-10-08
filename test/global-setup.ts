import { Client } from 'pg';
import { migrate } from '../scripts/migrate';
import { ADMIN_URL, TEST_DATABASE_URL, TEST_DB_NAME } from './env';

// Se ejecuta una vez antes de todas las pruebas: base nueva y migrada (001 + 002) desde cero.
export default async function globalSetup(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    // FORCE desconecta a cualquiera que haya quedado conectado de una ejecución anterior.
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  } finally {
    await admin.end();
  }
  await migrate(TEST_DATABASE_URL);
}
