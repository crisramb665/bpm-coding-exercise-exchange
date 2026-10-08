import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Pool, PoolClient } from 'pg';
import { PG_POOL, withTransaction } from '../common/db/pg-pool';
import { BusinessError, toErrorBody } from '../common/errors/business-error';
import { ComplianceClient } from '../compliance-service/compliance.client';
import { ComplianceResult, RiskLevel } from '../compliance-service/compliance.types';
import { LedgerRepository } from '../wallets/ledger.repository';
import { ExchangeDetailRepository } from './exchange-detail.repository';
import { ExchangesRepository } from './exchanges.repository';
import { IdempotencyRepository } from './idempotency.repository';

// Respuesta que el controller envía tal cual. `replayed` = es la respuesta guardada de una petición anterior.
export interface ExchangeResponse {
  status: number;
  body: unknown;
  replayed: boolean;
}

// Resultado de la primera transacción (Tx1).
export type BeginResult =
  // Reservado: la operación existe en PROCESSING y falta ejecutarla (Tx2). Se devuelve lo que hace falta para consultar
  // a cumplimiento sin volver a leer la base.
  | { kind: 'STARTED'; exchangeId: string; sourceAsset: string; sourceAmount: string }
  | { kind: 'REPLAY'; status: number; body: unknown }; // la clave ya tenía una respuesta definitiva guardada

// Lo que decide una Tx1 antes de cerrar la transacción. REJECTED = error definitivo que se guarda bajo la clave y se
// confirma (COMMIT); los errores transitorios NO pasan por aquí: se lanzan dentro de la transacción para hacer ROLLBACK.
type Tx1Result = BeginResult | { kind: 'REJECTED'; error: BusinessError };

// Resultado de la segunda transacción (Tx2). FAILED = la operación quedó FAILED, la clave se liberó y la transacción se
// confirmó; el error se le responde al cliente DESPUÉS del commit.
type Tx2Result = { kind: 'DONE'; body: unknown } | { kind: 'FAILED'; error: BusinessError };

@Injectable()
export class ExchangesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly exchanges: ExchangesRepository,
    private readonly idempotency: IdempotencyRepository,
    private readonly details: ExchangeDetailRepository,
    private readonly ledger: LedgerRepository,
    private readonly compliance: ComplianceClient,
  ) {}

  // POST /exchanges completo (docs/plan.md §5):  Tx1 (reservar) → consultar a cumplimiento → Tx2 (aplicar).
  async create(userId: string, idempotencyKey: string, quoteId: string): Promise<ExchangeResponse> {
    const started = await this.begin(userId, idempotencyKey, quoteId);
    if (started.kind === 'REPLAY') return { status: started.status, body: started.body, replayed: true };

    // Entre las dos transacciones, FUERA de toda transacción: no hay ninguna fila ni conexión retenida mientras se espera
    // a un servicio que en producción sería externo y lento. El cliente nunca lanza: una falla llega como outcome 'ERROR'.
    const check = await this.compliance.assess({
      exchangeId: started.exchangeId,
      userId,
      sourceAsset: started.sourceAsset,
      sourceAmount: started.sourceAmount,
    });

    const result = await withTransaction(this.pool, (client) => this.execute(client, userId, idempotencyKey, started.exchangeId, check));

    if (result.kind === 'FAILED') throw result.error; // la operación ya quedó FAILED y confirmada; ahora se responde el error
    return { status: 201, body: result.body, replayed: false };
  }

  // PRIMERA TRANSACCIÓN (docs/plan.md §5): corta y sin llamadas externas. Reserva la clave de idempotencia, bloquea la
  // cotización, valida y crea la operación en PROCESSING. Lanza BusinessError en los casos de error.
  async begin(userId: string, idempotencyKey: string, quoteId: string): Promise<BeginResult> {
    const requestHash = hashRequest(quoteId);

    let result: Tx1Result;
    try {
      result = await withTransaction(this.pool, (client) => this.reserve(client, userId, idempotencyKey, quoteId, requestHash));
    } catch (err) {
      throw translateConstraintError(err, quoteId);
    }

    // Los errores definitivos ya quedaron guardados y confirmados; ahora se le responden al cliente.
    if (result.kind === 'REJECTED') throw result.error;
    return result;
  }

  private async reserve(
    client: PoolClient,
    userId: string,
    key: string,
    quoteId: string,
    requestHash: string,
  ): Promise<Tx1Result> {
    // 1) Reservar la clave. Si ya existía, o se reproduce su respuesta o se rechaza (todo esto sin tocar nada más).
    const replay = await this.reserveKey(client, userId, key, requestHash);
    if (replay) return replay;

    // Desde aquí la clave es nuestra: lanzar un error = ROLLBACK = la clave se libera (errores transitorios).
    // Devolver REJECTED = se guarda la respuesta bajo la clave y se confirma (errores definitivos).
    const reject = async (error: BusinessError): Promise<Tx1Result> => {
      await this.idempotency.storeResponse(client, userId, key, error.httpStatus, toErrorBody(error));
      return { kind: 'REJECTED', error };
    };

    // 2) Bloquear la cotización. Es el punto que serializa a todas las peticiones sobre la misma cotización.
    const quote = await this.exchanges.lockQuote(client, quoteId, userId);
    if (!quote) return reject(new BusinessError('QUOTE_NOT_FOUND', 404, 'La cotización no existe', { quote_id: quoteId }));

    // 3) ¿Ya tiene un intercambio vivo? Va ANTES del vencimiento: si otra operación ya la tomó, esta petición no debe
    // marcarla EXPIRED por encima de ella.
    const live = await this.exchanges.findLiveByQuote(client, quote.id);
    if (live?.status === 'PROCESSING') {
      // Transitorio: ese intercambio puede terminar FAILED y entonces la cotización vuelve a estar disponible.
      throw new BusinessError('QUOTE_IN_USE', 409, 'La cotización está siendo utilizada por otra operación en curso', { quote_id: quote.id });
    }
    if (live || quote.status === 'USED') {
      return reject(new BusinessError('QUOTE_ALREADY_USED', 409, 'La cotización ya fue utilizada', { quote_id: quote.id }));
    }

    // 4) Vigencia. Una cotización EXPIRED no vuelve a ACTIVE (trigger), así que el resultado es definitivo.
    if (quote.status === 'EXPIRED' || (await this.exchanges.hasExpired(client, quote.id))) {
      await this.exchanges.markQuoteExpired(client, quote.id);
      return reject(new BusinessError('QUOTE_EXPIRED', 422, 'La cotización venció', { quote_id: quote.id }));
    }

    // 5) Saldo preliminar, sin bloqueo: solo para fallar rápido. La decisión definitiva es la de la segunda transacción.
    // Transitorio (el saldo puede cambiar), así que no se guarda: se lanza y la clave se libera.
    const available = await this.exchanges.availableBalance(client, userId, quote.source_asset);
    if (available === undefined) throw new Error(`El usuario ${userId} no tiene wallet de ${quote.source_asset}`);
    if (new Decimal(available).lt(quote.source_amount)) {
      throw new BusinessError('INSUFFICIENT_FUNDS', 422, 'El saldo disponible es insuficiente', {
        available,
        required: quote.source_amount,
        asset: quote.source_asset,
      });
    }

    // 6) Crear la operación en PROCESSING con su evento y enlazarla a la clave. La cotización sigue ACTIVE: pasa a USED
    // en la segunda transacción (D8), para poder reutilizarla si el servicio de cumplimiento falla.
    const exchangeId = await this.exchanges.insert(client, userId, quote.id, key);
    await this.exchanges.insertEvent(client, exchangeId, null, 'PROCESSING', userId);
    await this.idempotency.linkExchange(client, userId, key, exchangeId);

    return { kind: 'STARTED', exchangeId, sourceAsset: quote.source_asset, sourceAmount: quote.source_amount };
  }

  // SEGUNDA TRANSACCIÓN (docs/plan.md §5): aplica el resultado de cumplimiento. Bloquea en el orden global
  // exchange → quote → wallets (ordenadas por id), vuelve a validar el saldo BAJO bloqueo y mueve el dinero con
  // LedgerRepository. O queda todo (movimientos, estado de la operación, cotización, respuesta guardada) o no queda nada.
  private async execute(
    client: PoolClient,
    userId: string,
    key: string,
    exchangeId: string,
    check: ComplianceResult,
  ): Promise<Tx2Result> {
    // 1) La operación. Si ya no está en PROCESSING (la recuperación de huérfanas la marcó FAILED mientras se esperaba a
    // cumplimiento, D9) no se toca nada: ya no hay a quién aplicarle el resultado.
    const exchange = await this.exchanges.lockExchange(client, exchangeId);
    if (!exchange || exchange.status !== 'PROCESSING') {
      throw new BusinessError('EXCHANGE_NOT_PROCESSING', 409, 'La operación ya no está en proceso', { exchange_id: exchangeId });
    }

    // 2) La cotización, con lo que se cotizó (R9: no se recalcula nada) y los activos de cada lado (D18).
    const quote = await this.exchanges.lockQuoteForExecution(client, exchange.quote_id);

    // 3) Las wallets, ordenadas por id. Desde aquí el saldo leído no puede cambiar hasta el COMMIT: es lo que impide
    // que dos operaciones simultáneas gasten el mismo saldo.
    const wallets = await this.ledger.lockWallets(client, userId, [quote.source_asset, quote.target_asset]);
    const sourceWallet = wallets.find((w) => w.asset === quote.source_asset);
    const targetWallet = wallets.find((w) => w.asset === quote.target_asset);
    if (!sourceWallet || !targetWallet) throw new Error(`Faltan wallets de ${userId} para ${quote.source_asset}/${quote.target_asset}`);

    // 4) Dejar constancia de la consulta a cumplimiento, haya salido bien o mal.
    await this.exchanges.insertComplianceCheck(client, exchangeId, check);

    // Cierra la operación como FAILED: sin movimientos, con su motivo, y libera la clave de idempotencia (D11) para que
    // el cliente reintente con la misma clave. La cotización NO se marca USED: sigue disponible (D7, D8).
    const fail = async (reason: string, riskLevel: RiskLevel | null, error: BusinessError): Promise<Tx2Result> => {
      await this.exchanges.updateExchange(client, exchangeId, { status: 'FAILED', riskLevel, requiresFollowUp: false, failureReason: reason });
      await this.exchanges.insertEvent(client, exchangeId, 'PROCESSING', 'FAILED', null, reason);
      await this.idempotency.release(client, userId, key);
      return { kind: 'FAILED', error };
    };

    // 5a) El servicio de cumplimiento falló o no respondió a tiempo: no se mueve nada (R12, D7).
    if (check.outcome === 'ERROR') {
      return fail(
        'COMPLIANCE_UNAVAILABLE',
        null,
        new BusinessError('COMPLIANCE_UNAVAILABLE', 503, 'El servicio de cumplimiento no está disponible, intenta de nuevo', { exchange_id: exchangeId }),
      );
    }
    const risk = check.riskLevel;

    // 5b) Saldo, vuelto a leer BAJO bloqueo. El de la primera transacción era solo una comprobación rápida: pudo gastarse
    // en otra operación mientras se esperaba a cumplimiento.
    if (new Decimal(sourceWallet.available).lt(quote.source_amount)) {
      return fail(
        'INSUFFICIENT_FUNDS',
        risk,
        new BusinessError('INSUFFICIENT_FUNDS', 422, 'El saldo disponible es insuficiente', {
          available: sourceWallet.available,
          required: quote.source_amount,
          asset: quote.source_asset,
          exchange_id: exchangeId,
        }),
      );
    }

    // 5c / 5d) Mover el dinero. Siempre sale primero el débito del disponible, con el monto bruto cotizado (S2).
    const reference = { type: 'EXCHANGE', exchangeId } as const;
    await this.ledger.applyMovement(client, {
      walletId: sourceWallet.id,
      entryType: 'DEBIT',
      balanceType: 'AVAILABLE',
      amount: quote.source_amount,
      reference,
    });

    let finalStatus: 'COMPLETED' | 'PENDING_REVIEW';
    if (risk === 'HIGH') {
      // HIGH: el monto pasa de disponible a retenido, en la misma wallet; Cumplimiento decide después (D1).
      await this.ledger.applyMovement(client, {
        walletId: sourceWallet.id,
        entryType: 'CREDIT',
        balanceType: 'HELD',
        amount: quote.source_amount,
        reference,
      });
      finalStatus = 'PENDING_REVIEW';
    } else {
      // LOW / MEDIUM: se acredita el XAUT cotizado, tal cual (R9).
      await this.ledger.applyMovement(client, {
        walletId: targetWallet.id,
        entryType: 'CREDIT',
        balanceType: 'AVAILABLE',
        amount: quote.target_amount,
        reference,
      });
      finalStatus = 'COMPLETED';
    }

    await this.exchanges.updateExchange(client, exchangeId, {
      status: finalStatus,
      riskLevel: risk,
      requiresFollowUp: risk === 'MEDIUM', // solo MEDIUM completada queda marcada para seguimiento
      failureReason: null,
    });
    await this.exchanges.markQuoteUsed(client, quote.id); // la cotización se consume aquí y no antes (D8)
    await this.exchanges.insertEvent(client, exchangeId, 'PROCESSING', finalStatus, null, `Riesgo ${risk}`);

    // La respuesta se arma DENTRO de la transacción, con lo que acaba de escribir, y se guarda bajo la clave: repetir la
    // petición devolverá exactamente esto (D11).
    const detail = await this.details.findById(client, exchangeId);
    await this.idempotency.storeResponse(client, userId, key, 201, detail);
    return { kind: 'DONE', body: detail };
  }

  // Paso 1 de Tx1. Devuelve undefined si la clave quedó reservada para esta petición; devuelve la respuesta a reproducir
  // si la clave ya tenía una; lanza si hay conflicto (otro contenido, o la petición original sigue en curso).
  private async reserveKey(client: PoolClient, userId: string, key: string, requestHash: string): Promise<BeginResult | undefined> {
    // Bucle de 3 intentos: entre el INSERT que no insertó y el SELECT, la otra petición pudo LIBERAR la clave (falló con
    // un error transitorio) y la fila ya no existe. En ese caso se vuelve a intentar reservarla.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await this.idempotency.reserve(client, userId, key, requestHash)) return undefined;

      const existing = await this.idempotency.find(client, userId, key);
      if (!existing) continue;

      if (existing.request_hash !== requestHash) {
        throw new BusinessError('IDEMPOTENCY_KEY_MISMATCH', 409, 'La clave de idempotencia ya se usó con otro contenido');
      }
      if (existing.response_status === null) {
        throw new BusinessError('IDEMPOTENCY_IN_PROGRESS', 409, 'La petición original con esta clave aún no termina');
      }
      return { kind: 'REPLAY', status: existing.response_status, body: existing.response_body };
    }
    throw new Error(`No se pudo reservar la clave de idempotencia de ${userId} tras varios intentos`);
  }
}

// Huella del contenido de la petición: dos peticiones con la misma clave son "el mismo contenido" si dan la misma huella.
// Un uuid en mayúsculas o minúsculas es el mismo uuid, así que se normaliza antes.
export function hashRequest(quoteId: string): string {
  return createHash('sha256').update(JSON.stringify({ quote_id: quoteId.toLowerCase() })).digest('hex');
}

// Respaldo del paso 3: si, pese al bloqueo de la cotización, el índice único parcial de exchanges detecta dos
// intercambios vivos, se responde igual que el paso 3 en lugar de un 500.
export function translateConstraintError(err: unknown, quoteId: string): unknown {
  const pgError = err as { code?: string; constraint?: string };
  if (pgError?.code === '23505' && pgError.constraint === 'exchanges_quote_live_uq') {
    return new BusinessError('QUOTE_IN_USE', 409, 'La cotización está siendo utilizada por otra operación en curso', { quote_id: quoteId });
  }
  return err;
}
