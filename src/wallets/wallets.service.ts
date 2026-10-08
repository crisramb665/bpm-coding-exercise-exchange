import { Injectable } from '@nestjs/common';
import { BusinessError } from '../common/errors/business-error';
import { MovementRow, WalletRow, WalletsRepository } from './wallets.repository';

@Injectable()
export class WalletsService {
  constructor(private readonly wallets: WalletsRepository) {}

  listWallets(userId: string): Promise<WalletRow[]> {
    return this.wallets.findByUser(userId);
  }

  async listMovements(userId: string, walletId: string, limit: number): Promise<MovementRow[]> {
    // 404 y no 403 cuando la wallet es de otro usuario: así no se revela si el id existe (docs/spec.md §5.2).
    if (!(await this.wallets.existsForUser(walletId, userId))) {
      throw new BusinessError('WALLET_NOT_FOUND', 404, 'La wallet no existe');
    }
    return this.wallets.findMovements(walletId, limit);
  }
}
