import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from './pg-pool';

const DEFAULT_DATABASE_URL = 'postgres://exchange:exchange@localhost:5433/exchange';

// Global: cualquier servicio puede inyectar @Inject(PG_POOL) sin importar este módulo.
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): Pool => {
        // pg devuelve las columnas numeric como string y NO se configura ningún type parser:
        // los montos solo se convierten con decimal.js (regla 3 de CLAUDE.md).
        const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL });
        // Un error en una conexión ociosa (p. ej. la base se reinicia) sin manejador tumba el proceso.
        pool.on('error', (err) => console.error('Error en una conexión ociosa del pool:', err.message));
        return pool;
      },
    },
  ],
  exports: [PG_POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // Se ejecuta con app.close(); sin esto las pruebas (y el apagado) dejarían conexiones abiertas.
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
