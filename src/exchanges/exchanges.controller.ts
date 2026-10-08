import { Body, Controller, Get, Headers, Param, Post, Query, Res } from '@nestjs/common';
import { AuthUser } from '../common/auth/auth.types';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { Roles } from '../common/auth/roles.guard';
import { uuidParam, validationError } from '../common/errors/validation-error';
import { parseLimit } from '../common/http/parse-limit';
import { CreateExchangeDto } from './dto/create-exchange.dto';
import { ExchangeDetail, ExchangeSummary } from './exchange-detail.repository';
import { ExchangesQueryService } from './exchanges-query.service';
import { ExchangesService } from './exchanges.service';

const MAX_KEY_LENGTH = 255; // el mismo límite que el CHECK de idempotency_keys

// Lo mínimo que se usa de la respuesta HTTP (evita depender de los tipos de express).
interface HttpResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

// Solo USER ejecuta intercambios: COMPLIANCE recibe 403 (D14). Las consultas (GET) sí admiten a los dos roles; el método
// anula el @Roles de la clase y la regla de quién ve qué la aplica ExchangesQueryService.
@Controller('exchanges')
@Roles('USER')
export class ExchangesController {
  constructor(
    private readonly service: ExchangesService,
    private readonly queries: ExchangesQueryService,
  ) {}

  @Get()
  @Roles('USER', 'COMPLIANCE')
  list(
    @CurrentUser() user: AuthUser,
    @Query('userId') userId?: string | string[],
    @Query('limit') limit?: string,
  ): Promise<ExchangeSummary[]> {
    return this.queries.list(user, parseUserIdFilter(userId), parseLimit(limit));
  }

  @Get(':id')
  @Roles('USER', 'COMPLIANCE')
  detail(@CurrentUser() user: AuthUser, @Param('id', uuidParam('id')) id: string): Promise<ExchangeDetail> {
    return this.queries.getDetail(user, id);
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body() dto: CreateExchangeDto,
    // passthrough: se fija el status y el encabezado a mano, pero Nest sigue enviando el valor que se devuelve.
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<unknown> {
    const key = parseIdempotencyKey(rawKey);
    const outcome = await this.service.create(user.id, key, dto.quote_id);

    res.status(outcome.status);
    if (outcome.replayed) res.setHeader('Idempotent-Replayed', 'true'); // la respuesta es la guardada de una petición anterior
    return outcome.body;
  }
}

// El encabezado es obligatorio (3.9) y debe tener de 1 a 255 caracteres. Un 400 no consume la clave: aún no se reservó.
function parseIdempotencyKey(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    throw validationError('Idempotency-Key', 'El encabezado Idempotency-Key es obligatorio');
  }
  if (raw.length > MAX_KEY_LENGTH) {
    throw validationError('Idempotency-Key', `Idempotency-Key admite como máximo ${MAX_KEY_LENGTH} caracteres`);
  }
  return raw;
}

// ?userId= es opcional, pero si viene debe ser un texto no vacío y único (un parámetro repetido llega como arreglo).
function parseUserIdFilter(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 100) {
    throw validationError('userId', 'userId debe ser un texto no vacío, de hasta 100 caracteres, y no repetirse');
  }
  return raw;
}
