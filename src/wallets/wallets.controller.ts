import { Controller, Get, Param, Query } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from "@nestjs/swagger";
import { AuthUser } from "../common/auth/auth.types";
import { CurrentUser } from "../common/auth/current-user.decorator";
import { uuidParam } from "../common/errors/validation-error";
import { parseLimit } from "../common/http/parse-limit";
import { ApiErrors } from "../common/swagger/api-errors";
import { MOVEMENTS_EXAMPLE, WALLETS_EXAMPLE } from "../common/swagger/examples";
import { MovementRow, WalletRow } from "./wallets.repository";
import { WalletsService } from "./wallets.service";

// Sin @Roles: tanto USER como COMPLIANCE consultan sus propias wallets (S5). Cada uno solo ve las suyas.
@ApiTags("Wallets")
@ApiSecurity("X-User-Id")
@Controller("wallets")
export class WalletsController {
  constructor(private readonly service: WalletsService) {}

  @Get()
  @ApiOperation({
    summary: "Mis wallets",
    description:
      "Una wallet por activo, con saldo disponible, retenido y total. Cada usuario ve solo las suyas (Cumplimiento también: las suyas, en cero).",
  })
  @ApiOkResponse({
    description: "Las wallets del usuario, ordenadas por activo.",
    schema: { example: WALLETS_EXAMPLE },
  })
  @ApiErrors({ 401: "UNAUTHENTICATED" })
  list(@CurrentUser() user: AuthUser): Promise<WalletRow[]> {
    return this.service.listWallets(user.id);
  }

  @Get(":id/movements")
  @ApiOperation({
    summary: "Movimientos de una wallet",
    description:
      "Del más reciente al más antiguo. Cada movimiento trae el saldo anterior y el posterior, así que el saldo se puede reconstruir. " +
      "Una wallet ajena da 404, igual que una inexistente: no se revela qué ids existen.",
  })
  @ApiParam({
    name: "id",
    description: "Id de la wallet (uuid), de GET /wallets.",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Entero de 1 a 200. Por defecto 50.",
    example: 50,
  })
  @ApiOkResponse({
    description: "Los movimientos de la wallet.",
    schema: { example: MOVEMENTS_EXAMPLE },
  })
  @ApiErrors({
    400: "VALIDATION_ERROR (id que no es uuid, o limit inválido)",
    401: "UNAUTHENTICATED",
    404: "WALLET_NOT_FOUND",
  })
  movements(
    @CurrentUser() user: AuthUser,
    @Param("id", uuidParam("id")) walletId: string,
    @Query("limit") limit?: string,
  ): Promise<MovementRow[]> {
    return this.service.listMovements(user.id, walletId, parseLimit(limit));
  }
}
