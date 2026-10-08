import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from "@nestjs/swagger";
import { AuthUser } from "../common/auth/auth.types";
import { CurrentUser } from "../common/auth/current-user.decorator";
import { Roles } from "../common/auth/roles.guard";
import { uuidParam, validationError } from "../common/errors/validation-error";
import { parseLimit } from "../common/http/parse-limit";
import { ApiErrors } from "../common/swagger/api-errors";
import {
  EXCHANGE_DETAIL_EXAMPLE,
  EXCHANGE_SUMMARY_EXAMPLE,
} from "../common/swagger/examples";
import { CreateExchangeDto } from "./dto/create-exchange.dto";
import { ExchangeDetail, ExchangeSummary } from "./exchange-detail.repository";
import { ExchangesQueryService } from "./exchanges-query.service";
import { ExchangesService } from "./exchanges.service";

const MAX_KEY_LENGTH = 255; // el mismo límite que el CHECK de idempotency_keys

// Lo mínimo que se usa de la respuesta HTTP (evita depender de los tipos de express).
interface HttpResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

// Solo USER ejecuta intercambios: COMPLIANCE recibe 403 (D14). Las consultas (GET) sí admiten a los dos roles; el método
// anula el @Roles de la clase y la regla de quién ve qué la aplica ExchangesQueryService.
@ApiTags("Intercambios")
@ApiSecurity("X-User-Id")
@Controller("exchanges")
@Roles("USER")
export class ExchangesController {
  constructor(
    private readonly service: ExchangesService,
    private readonly queries: ExchangesQueryService,
  ) {}

  @Get()
  @Roles("USER", "COMPLIANCE")
  @ApiOperation({
    summary: "Listar operaciones",
    description:
      "Las más recientes primero. Un USER ve solo las suyas; Cumplimiento ve las de todos y puede filtrar con userId. " +
      "Un USER que envía el userId de otro usuario recibe 403 (no se ignora en silencio).",
  })
  @ApiQuery({
    name: "userId",
    required: false,
    description: "Solo Cumplimiento: limitar a las operaciones de ese usuario.",
    example: "user-001",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Entero de 1 a 200. Por defecto 50.",
    example: 50,
  })
  @ApiOkResponse({
    description:
      "Resumen de cada operación. Los montos salen de la cotización.",
    schema: { example: EXCHANGE_SUMMARY_EXAMPLE },
  })
  @ApiErrors({
    400: "VALIDATION_ERROR (userId vacío o repetido, limit inválido)",
    401: "UNAUTHENTICATED",
    403: "FORBIDDEN (un USER pidió el userId de otro)",
  })
  list(
    @CurrentUser() user: AuthUser,
    @Query("userId") userId?: string | string[],
    @Query("limit") limit?: string,
  ): Promise<ExchangeSummary[]> {
    return this.queries.list(
      user,
      parseUserIdFilter(userId),
      parseLimit(limit),
    );
  }

  @Get(":id")
  @Roles("USER", "COMPLIANCE")
  @ApiOperation({
    summary: "Detalle y trazabilidad de una operación",
    description:
      "Cotización usada (precio y comisión originales), movimientos del ledger con saldo anterior y posterior, consultas al servicio de " +
      "cumplimiento, decisión de Cumplimiento si existe, y el historial de estados con quién hizo cada transición. Es el mismo cuerpo que " +
      "devuelve POST /exchanges. El dueño o Cumplimiento; la operación de otro usuario da 404, igual que una inexistente.",
  })
  @ApiParam({ name: "id", description: "Id de la operación (uuid)." })
  @ApiOkResponse({
    description: "El detalle completo de la operación.",
    schema: { example: EXCHANGE_DETAIL_EXAMPLE },
  })
  @ApiErrors({
    400: "VALIDATION_ERROR (id que no es uuid)",
    401: "UNAUTHENTICATED",
    404: "EXCHANGE_NOT_FOUND",
  })
  detail(
    @CurrentUser() user: AuthUser,
    @Param("id", uuidParam("id")) id: string,
  ): Promise<ExchangeDetail> {
    return this.queries.getDetail(user, id);
  }

  @Post()
  @ApiOperation({
    summary: "Ejecutar un intercambio",
    description:
      "Ejecuta una cotización vigente. Según el monto bruto, el servicio de cumplimiento responde LOW (< 1.000): COMPLETED; " +
      "MEDIUM (1.000 a 5.000, inclusive): COMPLETED con requires_follow_up = true; HIGH (> 5.000): PENDING_REVIEW, con el monto retenido " +
      "hasta que Cumplimiento decida. **Idempotente**: repetir la misma Idempotency-Key con el mismo contenido devuelve la respuesta " +
      "original (con el encabezado Idempotent-Replayed: true) sin duplicar movimientos; con otro contenido, 409. Si el servicio de " +
      "cumplimiento falla, la operación queda FAILED sin tocar saldos, la cotización sigue disponible y la clave se libera. Rol: USER.",
  })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description:
      "De 1 a 255 caracteres. Elige una nueva por cada intención de operación y reutilízala solo para reintentar la misma.",
    example: "compra-0001",
  })
  @ApiCreatedResponse({
    description:
      "La operación ejecutada (COMPLETED) o retenida (PENDING_REVIEW). Mismo cuerpo que GET /exchanges/{id}.",
    schema: { example: EXCHANGE_DETAIL_EXAMPLE },
  })
  @ApiErrors({
    400: "VALIDATION_ERROR (falta Idempotency-Key, o quote_id no es uuid)",
    401: "UNAUTHENTICATED",
    403: "FORBIDDEN (el rol COMPLIANCE no ejecuta intercambios)",
    404: "QUOTE_NOT_FOUND (no existe o es de otro usuario)",
    409: "IDEMPOTENCY_KEY_MISMATCH · IDEMPOTENCY_IN_PROGRESS · QUOTE_ALREADY_USED · QUOTE_IN_USE · EXCHANGE_NOT_PROCESSING",
    422: "QUOTE_EXPIRED · INSUFFICIENT_FUNDS",
    503: "COMPLIANCE_UNAVAILABLE (el servicio de cumplimiento falló o no respondió; la clave queda libre para reintentar)",
  })
  async create(
    @CurrentUser() user: AuthUser,
    @Headers("idempotency-key") rawKey: string | undefined,
    @Body() dto: CreateExchangeDto,
    // passthrough: se fija el status y el encabezado a mano, pero Nest sigue enviando el valor que se devuelve.
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<unknown> {
    const key = parseIdempotencyKey(rawKey);
    const outcome = await this.service.create(user.id, key, dto.quote_id);

    res.status(outcome.status);
    if (outcome.replayed) res.setHeader("Idempotent-Replayed", "true"); // la respuesta es la guardada de una petición anterior
    return outcome.body;
  }
}

// El encabezado es obligatorio (3.9) y debe tener de 1 a 255 caracteres. Un 400 no consume la clave: aún no se reservó.
function parseIdempotencyKey(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    throw validationError(
      "Idempotency-Key",
      "El encabezado Idempotency-Key es obligatorio",
    );
  }
  if (raw.length > MAX_KEY_LENGTH) {
    throw validationError(
      "Idempotency-Key",
      `Idempotency-Key admite como máximo ${MAX_KEY_LENGTH} caracteres`,
    );
  }
  return raw;
}

// ?userId= es opcional, pero si viene debe ser un texto no vacío y único (un parámetro repetido llega como arreglo).
function parseUserIdFilter(
  raw: string | string[] | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > 100) {
    throw validationError(
      "userId",
      "userId debe ser un texto no vacío, de hasta 100 caracteres, y no repetirse",
    );
  }
  return raw;
}
