import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/pg-pool';
import { BusinessError } from '../errors/business-error';
import { AuthedRequest, AuthUser } from './auth.types';

// Autenticación simplificada (enunciado 3.2): el encabezado X-User-Id identifica al usuario.
// Cualquier ruta, salvo que se indique lo contrario, exige un usuario existente → 401 si no.
// Se registra como guard global, así que corre ANTES de los pipes de validación: sin usuario, el 401 gana al 400.
// En producción esto se sustituiría por la verificación de un token (OIDC) y el rol saldría del token.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const userId = req.headers['x-user-id'];

    // Un encabezado repetido llega como arreglo: no se acepta, es ambiguo.
    if (typeof userId !== 'string' || userId.trim() === '') {
      throw unauthenticated('Falta el encabezado X-User-Id');
    }

    const { rows } = await this.pool.query<AuthUser>('SELECT id, role, name FROM users WHERE id = $1', [userId]);
    if (rows.length === 0) throw unauthenticated('Usuario no identificado');

    req.user = rows[0];
    return true;
  }
}

function unauthenticated(message: string): BusinessError {
  return new BusinessError('UNAUTHENTICATED', 401, message);
}
