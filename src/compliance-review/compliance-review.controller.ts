import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
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
import { Roles } from "../common/auth/roles.guard";
import { uuidParam } from "../common/errors/validation-error";
import { parseLimit } from "../common/http/parse-limit";
import { ApiErrors } from "../common/swagger/api-errors";
import {
  EXCHANGE_DETAIL_EXAMPLE,
  PENDING_EXAMPLE,
} from "../common/swagger/examples";
import { ExchangeDetail } from "../exchanges/exchange-detail.repository";
import { ComplianceReviewService } from "./compliance-review.service";
import { PendingExchange } from "./compliance-review.repository";
import { ApproveDto, RejectDto } from "./dto/review-decision.dto";

// Solo el rol COMPLIANCE: un USER recibe 403 en las tres rutas (segregación de funciones, enunciado 3.2).
@ApiTags("Cumplimiento (revisión humana)")
@ApiSecurity("X-User-Id")
@Controller("compliance/exchanges")
@Roles("COMPLIANCE")
export class ComplianceReviewController {
  constructor(private readonly service: ComplianceReviewService) {}

  @Get("pending")
  @ApiOperation({
    summary: "Bandeja de operaciones retenidas",
    description:
      "Las operaciones HIGH en PENDING_REVIEW, de la más antigua a la más reciente. Rol: COMPLIANCE.",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Entero de 1 a 200. Por defecto 50.",
    example: 50,
  })
  @ApiOkResponse({
    description: "Operaciones pendientes de decisión.",
    schema: { example: PENDING_EXAMPLE },
  })
  @ApiErrors({
    400: "VALIDATION_ERROR (limit inválido)",
    401: "UNAUTHENTICATED",
    403: "FORBIDDEN (solo el rol COMPLIANCE)",
  })
  pending(@Query("limit") limit?: string): Promise<PendingExchange[]> {
    return this.service.listPending(parseLimit(limit));
  }

  @Patch(":id/approve")
  @ApiOperation({
    summary: "Aprobar una operación retenida",
    description:
      "Se debita el saldo retenido, se acredita el XAUT-SBX cotizado y la operación pasa a COMPLETED. Se usa el precio de la cotización " +
      "original aunque ya haya vencido mientras la operación esperaba. El motivo es opcional. Rol: COMPLIANCE.",
  })
  @ApiParam({
    name: "id",
    description: "Id de la operación (uuid) en PENDING_REVIEW.",
  })
  @ApiOkResponse({
    description: "La operación ya aprobada, con la decisión registrada.",
    schema: { example: EXCHANGE_DETAIL_EXAMPLE },
  })
  @ApiErrors({
    400: "VALIDATION_ERROR (id que no es uuid, o motivo inválido)",
    401: "UNAUTHENTICATED",
    403: "FORBIDDEN (solo el rol COMPLIANCE)",
    404: "EXCHANGE_NOT_FOUND",
    409: "EXCHANGE_NOT_PENDING (ya fue decidida o no requiere revisión)",
  })
  approve(
    @CurrentUser() reviewer: AuthUser,
    @Param("id", uuidParam("id")) id: string,
    @Body() dto: ApproveDto,
  ): Promise<ExchangeDetail> {
    return this.service.approve(reviewer.id, id, dto.reason);
  }

  @Patch(":id/reject")
  @ApiOperation({
    summary: "Rechazar una operación retenida",
    description:
      "Se libera el saldo retenido (vuelve a disponible), no se acredita XAUT-SBX y la operación pasa a REJECTED. La cotización no se " +
      "reutiliza. El motivo es obligatorio. Rol: COMPLIANCE.",
  })
  @ApiParam({
    name: "id",
    description: "Id de la operación (uuid) en PENDING_REVIEW.",
  })
  @ApiOkResponse({
    description: "La operación ya rechazada, con la decisión registrada.",
    schema: { example: EXCHANGE_DETAIL_EXAMPLE },
  })
  @ApiErrors({
    400: "VALIDATION_ERROR (id que no es uuid, o falta el motivo)",
    401: "UNAUTHENTICATED",
    403: "FORBIDDEN (solo el rol COMPLIANCE)",
    404: "EXCHANGE_NOT_FOUND",
    409: "EXCHANGE_NOT_PENDING (ya fue decidida o no requiere revisión)",
  })
  reject(
    @CurrentUser() reviewer: AuthUser,
    @Param("id", uuidParam("id")) id: string,
    @Body() dto: RejectDto,
  ): Promise<ExchangeDetail> {
    return this.service.reject(reviewer.id, id, dto.reason);
  }
}
