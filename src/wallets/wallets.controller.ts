import { Controller, Get, Param, Query } from '@nestjs/common';
import { AuthUser } from '../common/auth/auth.types';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { uuidParam } from '../common/errors/validation-error';
import { parseLimit } from '../common/http/parse-limit';
import { MovementRow, WalletRow } from './wallets.repository';
import { WalletsService } from './wallets.service';

// Sin @Roles: tanto USER como COMPLIANCE consultan sus propias wallets (S5). Cada uno solo ve las suyas.
@Controller('wallets')
export class WalletsController {
  constructor(private readonly service: WalletsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser): Promise<WalletRow[]> {
    return this.service.listWallets(user.id);
  }

  @Get(':id/movements')
  movements(
    @CurrentUser() user: AuthUser,
    @Param('id', uuidParam('id')) walletId: string,
    @Query('limit') limit?: string,
  ): Promise<MovementRow[]> {
    return this.service.listMovements(user.id, walletId, parseLimit(limit));
  }
}
