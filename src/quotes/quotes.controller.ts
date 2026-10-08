import { Body, Controller, Post } from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from "@nestjs/swagger";
import { AuthUser } from "../common/auth/auth.types";
import { CurrentUser } from "../common/auth/current-user.decorator";
import { Roles } from "../common/auth/roles.guard";
import { ApiErrors } from "../common/swagger/api-errors";
import { QUOTE_EXAMPLE } from "../common/swagger/examples";
import { CreateQuoteDto } from "./dto/create-quote.dto";
import { QuoteRow } from "./quotes.repository";
import { QuotesService } from "./quotes.service";

// Solo USER cotiza: COMPLIANCE recibe 403 (segregación de funciones, D14).
@ApiTags("Cotizaciones")
@ApiSecurity("X-User-Id")
@Controller("quotes")
@Roles("USER")
export class QuotesController {
  constructor(private readonly service: QuotesService) {}

  @Post() // 201 por defecto en POST
  @ApiOperation({
    summary: "Solicitar una cotización",
    description:
      "Cotiza USDT-SBX por XAUT-SBX (único par soportado). Precio: 1 XAUT-SBX = 2.500 USDT-SBX. Comisión del 1 % sobre el monto en USDT-SBX, " +
      "redondeada hacia arriba, descontada antes de convertir; el XAUT-SBX a recibir se redondea hacia abajo. Vigencia de 30 segundos. " +
      "El precio, la comisión y los montos quedan guardados: la ejecución no los recalcula. Cotizar no exige saldo. Rol: USER.",
  })
  @ApiCreatedResponse({
    description: "La cotización creada, con su vencimiento.",
    schema: { example: QUOTE_EXAMPLE },
  })
  @ApiErrors({
    400: "VALIDATION_ERROR (monto con más de 8 decimales, cero, negativo o como número JSON; par no soportado)",
    401: "UNAUTHENTICATED",
    403: "FORBIDDEN (el rol COMPLIANCE no cotiza)",
    422: "AMOUNT_TOO_SMALL (el XAUT-SBX a recibir, redondeado hacia abajo, daría 0)",
  })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateQuoteDto,
  ): Promise<QuoteRow> {
    return this.service.create(user.id, dto);
  }
}
