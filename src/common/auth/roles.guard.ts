import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BusinessError } from '../errors/business-error';
import { AuthedRequest, Role } from './auth.types';

const ROLES_KEY = 'roles';

// Restringe una ruta (o un controller) a ciertos roles: @Roles('USER'). Sin @Roles, basta con estar autenticado.
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

// Segregación de funciones: un rol no autorizado recibe 403. Corre después de AuthGuard, que ya dejó el usuario en req.user.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // getAllAndOverride: un @Roles en el método tiene prioridad sobre uno en el controller.
    const allowed = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowed) return true;

    const user = context.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user || !allowed.includes(user.role)) {
      throw new BusinessError('FORBIDDEN', 403, 'El rol del usuario no permite esta acción');
    }
    return true;
  }
}
