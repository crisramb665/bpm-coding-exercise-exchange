import { Injectable } from '@nestjs/common';
import { QueryResult, QueryResultRow } from 'pg';

// Lo único que se necesita de la conexión: sirve tanto el Pool como el client de una transacción. Dentro de una
// transacción se pasa el client, para que el detalle refleje lo que esa transacción acaba de escribir.
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

// Detalle y trazabilidad completa de una operación (docs/spec.md §5.6). Es la respuesta del 201 de POST /exchanges y de
// GET /exchanges/:id. Los montos y el precio se leen de la cotización guardada (R9, D10), nunca se recalculan.
export interface ExchangeDetail {
  id: string;
  user_id: string;
  status: string;
  risk_level: string | null;
  requires_follow_up: boolean;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
  quote: Record<string, unknown>;
  movements: Record<string, unknown>[];
  compliance_checks: Record<string, unknown>[];
  decision: Record<string, unknown> | null;
  events: Record<string, unknown>[];
}

// Una fila del listado (docs/spec.md §5.5). Los montos salen de la cotización: la operación no los copia (D10).
export interface ExchangeSummary {
  id: string;
  user_id: string;
  status: string;
  risk_level: string | null;
  requires_follow_up: boolean;
  source_amount: string;
  target_amount: string;
  created_at: Date;
}

// Lecturas de operaciones: el detalle con su trazabilidad y el listado.
@Injectable()
export class ExchangeDetailRepository {
  // Las más recientes primero. `userId` null = de todos los usuarios (solo lo usa Cumplimiento). Usa el índice
  // exchanges_user_idx (user_id, created_at DESC); el id desempata operaciones con la misma hora de creación.
  async list(db: Queryable, userId: string | null, limit: number): Promise<ExchangeSummary[]> {
    const { rows } = await db.query<ExchangeSummary>(
      `SELECT e.id, e.user_id, e.status, e.risk_level, e.requires_follow_up, q.source_amount, q.target_amount, e.created_at
         FROM exchanges e JOIN quotes q ON q.id = e.quote_id
        WHERE ($1::text IS NULL OR e.user_id = $1)
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $2`,
      [userId, limit],
    );
    return rows;
  }

  async findById(db: Queryable, exchangeId: string): Promise<ExchangeDetail | undefined> {
    const exchange = await db.query<Omit<ExchangeDetail, 'quote' | 'movements' | 'compliance_checks' | 'decision' | 'events'> & { quote_id: string }>(
      `SELECT id, user_id, quote_id, status, risk_level, requires_follow_up, failure_reason, created_at, updated_at
         FROM exchanges WHERE id = $1`,
      [exchangeId],
    );
    if (exchange.rows.length === 0) return undefined;
    const { quote_id: quoteId, ...head } = exchange.rows[0];

    // Consultas en secuencia: sobre un mismo client de pg se encolan de todos modos.
    const quote = await db.query(
      `SELECT id, source_asset, target_asset, source_amount, price, fee_rate, fee_amount, net_amount,
              target_amount, created_at, expires_at, status
         FROM quotes WHERE id = $1`,
      [quoteId],
    );
    // El movimiento incluye el activo de su wallet para que se entienda sin cruzar tablas. Orden por id (determinista).
    const movements = await db.query(
      `SELECT l.id, l.wallet_id, w.asset_code AS asset, l.entry_type, l.balance_type, l.amount,
              l.balance_before, l.balance_after, l.status, l.created_at
         FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id
        WHERE l.exchange_id = $1
        ORDER BY l.id`,
      [exchangeId],
    );
    const checks = await db.query(
      `SELECT id, provider, outcome, risk_level, request_payload, response_payload, error_message, duration_ms, created_at
         FROM compliance_checks WHERE exchange_id = $1 ORDER BY id`,
      [exchangeId],
    );
    const decision = await db.query(
      'SELECT reviewer_id, decision, reason, decided_at FROM compliance_decisions WHERE exchange_id = $1',
      [exchangeId],
    );
    const events = await db.query(
      'SELECT id, from_status, to_status, actor_id, reason, created_at FROM exchange_events WHERE exchange_id = $1 ORDER BY id',
      [exchangeId],
    );

    return {
      ...head,
      quote: quote.rows[0],
      movements: movements.rows,
      compliance_checks: checks.rows,
      decision: decision.rows[0] ?? null,
      events: events.rows,
    };
  }
}
