import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { AuthUser } from '../common/auth/auth.types';
import { PG_POOL } from '../common/db/pg-pool';
import { BusinessError } from '../common/errors/business-error';
import { ExchangeDetail, ExchangeDetailRepository, ExchangeSummary } from './exchange-detail.repository';

// Consultas de operaciones (T13), separadas del servicio que las crea. Aquí viven las reglas de quién puede ver qué.
@Injectable()
export class ExchangesQueryService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly reads: ExchangeDetailRepository,
  ) {}

  // GET /exchanges. USER: solo las suyas (D6); si manda ?userId de otro usuario es un 403 explícito y no un resultado vacío
  // ni el ignorarlo en silencio (D13). COMPLIANCE: las de todos, o las de un usuario si lo indica.
  list(user: AuthUser, userIdFilter: string | undefined, limit: number): Promise<ExchangeSummary[]> {
    if (user.role === 'USER') {
      if (userIdFilter !== undefined && userIdFilter !== user.id) {
        throw new BusinessError('FORBIDDEN', 403, 'Un usuario solo puede consultar sus propias operaciones');
      }
      return this.reads.list(this.pool, user.id, limit);
    }
    return this.reads.list(this.pool, userIdFilter ?? null, limit);
  }

  // GET /exchanges/:id. El dueño o Cumplimiento. Para un USER, la operación de otro es indistinguible de una inexistente
  // (404 con el mismo cuerpo): no se revela qué ids existen.
  async getDetail(user: AuthUser, exchangeId: string): Promise<ExchangeDetail> {
    const detail = await this.reads.findById(this.pool, exchangeId);
    if (!detail || (user.role === 'USER' && detail.user_id !== user.id)) {
      throw new BusinessError('EXCHANGE_NOT_FOUND', 404, 'La operación no existe', { exchange_id: exchangeId });
    }
    return detail;
  }
}
