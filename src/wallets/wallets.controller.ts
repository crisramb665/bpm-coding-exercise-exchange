import { Controller, Get, Param, Query } from '@nestjs/common';
import { AuthUser } from '../common/auth/auth.types';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { uuidParam, validationError } from '../common/errors/validation-error';
import { MovementRow, WalletRow } from './wallets.repository';
import { WalletsService } from './wallets.service';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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

// `limit` es un entero de 1 a 200 (por defecto 50). Es un conteo, no un monto, así que aquí Number es correcto.
// Se valida a mano con una regex estricta: Number('1e2'), Number('') o Number(' 5 ') darían valores "válidos" que no queremos.
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^[1-9]\d{0,2}$/.test(raw) || Number(raw) > MAX_LIMIT) {
    throw validationError('limit', `limit debe ser un entero entre 1 y ${MAX_LIMIT}`);
  }
  return Number(raw);
}
