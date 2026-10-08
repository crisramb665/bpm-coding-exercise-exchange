import { Body, Controller, Headers, Post, Res } from '@nestjs/common';
import { AuthUser } from '../common/auth/auth.types';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { Roles } from '../common/auth/roles.guard';
import { validationError } from '../common/errors/validation-error';
import { CreateExchangeDto } from './dto/create-exchange.dto';
import { ExchangesService } from './exchanges.service';

const MAX_KEY_LENGTH = 255; // el mismo límite que el CHECK de idempotency_keys

// Lo mínimo que se usa de la respuesta HTTP (evita depender de los tipos de express).
interface HttpResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

// Solo USER ejecuta intercambios: COMPLIANCE recibe 403 (D14).
@Controller('exchanges')
@Roles('USER')
export class ExchangesController {
  constructor(private readonly service: ExchangesService) {}

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
