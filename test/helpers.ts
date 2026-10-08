import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, Type } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { TEST_DATABASE_URL } from './env';

// Pool propio de las pruebas, para preparar y consultar datos directamente en SQL.
export const testPool = new Pool({ connectionString: TEST_DATABASE_URL });

const SEED_SQL = readFileSync(join(__dirname, '..', 'migrations', '002_seed.sql'), 'utf8');

// Deja la base como recién migrada: vacía las tablas y vuelve a cargar la semilla (plan §2).
// TRUNCATE no dispara los triggers de solo inserción, que sí bloquean DELETE. schema_migrations no se toca.
export async function resetDb(): Promise<void> {
  await testPool.query(`
    TRUNCATE users, assets, wallets, quotes, exchanges, idempotency_keys, ledger_entries,
             compliance_checks, compliance_decisions, exchange_events
    RESTART IDENTITY CASCADE`);
  await testPool.query(SEED_SQL);
}

export interface CreateAppOptions {
  // Sustituye providers, por ejemplo el servicio de cumplimiento por uno que falla:
  // { overrides: (b) => b.overrideProvider(X).useValue(Y) }
  overrides?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  // Controllers que solo existen en las pruebas (p. ej. rutas de prueba para los guards).
  controllers?: Type<unknown>[];
}

// Levanta la app completa en memoria (sin abrir un puerto).
export async function createApp({ overrides, controllers }: CreateAppOptions = {}): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule], controllers });
  if (overrides) builder = overrides(builder);
  const app = (await builder.compile()).createNestApplication();
  await app.init();
  return app;
}

// Cada archivo de prueba lo llama en su afterAll para que Jest termine sin conexiones abiertas.
export async function closeDb(): Promise<void> {
  await testPool.end();
}
