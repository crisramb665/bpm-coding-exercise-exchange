import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Pool, PoolClient } from 'pg';
import { PG_POOL, withTransaction } from '../common/db/pg-pool';
import { BusinessError, toErrorBody } from '../common/errors/business-error';
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
  | { kind: 'STARTED'; exchangeId: string } // reservado: la operación existe en PROCESSING; falta ejecutarla (Tx2)
  | { kind: 'REPLAY'; status: number; body: unknown }; // la clave ya tenía una respuesta definitiva guardada

// Lo que decide una Tx1 antes de cerrar la transacción. REJECTED = error definitivo que se guarda bajo la clave y se
// confirma (COMMIT); los errores transitorios NO pasan por aquí: se lanzan dentro de la transacción para hacer ROLLBACK.
type Tx1Result = BeginResult | { kind: 'REJECTED'; error: BusinessError };

@Injectable()
export class ExchangesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly exchanges: ExchangesRepository,
    private readonly idempotency: IdempotencyRepository,
  ) {}

  async create(userId: string, idempotencyKey: string, quoteId: string): Promise<ExchangeResponse> {
    const result = await this.begin(userId, idempotencyKey, quoteId);
    if (result.kind === 'REPLAY') return { status: result.status, body: result.body, replayed: true };

    // La ejecución (consultar a cumplimiento y mover saldos: Tx2) llega en la T12. Hasta entonces una reserva exitosa
    // deja la operación en PROCESSING y se responde 501 para no aparentar que se ejecutó.
    throw new BusinessError('NOT_IMPLEMENTED', 501, 'La ejecución del intercambio se completa en la tarea T12', {
      exchange_id: result.exchangeId,
    });
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

    return { kind: 'STARTED', exchangeId };
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
