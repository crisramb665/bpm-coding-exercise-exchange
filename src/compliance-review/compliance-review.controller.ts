import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { AuthUser } from '../common/auth/auth.types';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { Roles } from '../common/auth/roles.guard';
import { uuidParam } from '../common/errors/validation-error';
import { parseLimit } from '../common/http/parse-limit';
import { ExchangeDetail } from '../exchanges/exchange-detail.repository';
import { ComplianceReviewService } from './compliance-review.service';
import { PendingExchange } from './compliance-review.repository';
import { ApproveDto, RejectDto } from './dto/review-decision.dto';

// Solo el rol COMPLIANCE: un USER recibe 403 en las tres rutas (segregación de funciones, enunciado 3.2).
@Controller('compliance/exchanges')
@Roles('COMPLIANCE')
export class ComplianceReviewController {
  constructor(private readonly service: ComplianceReviewService) {}

  @Get('pending')
  pending(@Query('limit') limit?: string): Promise<PendingExchange[]> {
    return this.service.listPending(parseLimit(limit));
  }

  @Patch(':id/approve')
  approve(@CurrentUser() reviewer: AuthUser, @Param('id', uuidParam('id')) id: string, @Body() dto: ApproveDto): Promise<ExchangeDetail> {
    return this.service.approve(reviewer.id, id, dto.reason);
  }

  @Patch(':id/reject')
  reject(@CurrentUser() reviewer: AuthUser, @Param('id', uuidParam('id')) id: string, @Body() dto: RejectDto): Promise<ExchangeDetail> {
    return this.service.reject(reviewer.id, id, dto.reason);
  }
}
