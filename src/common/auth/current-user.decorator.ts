import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthedRequest, AuthUser } from './auth.types';

// Entrega el usuario que dejó AuthGuard: `@CurrentUser() user: AuthUser`. Es el único decorador propio del proyecto
// (además de @Roles) y se justifica porque lo usan casi todos los endpoints.
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthUser => {
  const user = context.switchToHttp().getRequest<AuthedRequest>().user;
  // AuthGuard es global y siempre corre antes: llegar aquí sin usuario sería un error de configuración, no del cliente.
  if (!user) throw new Error('CurrentUser usado en una ruta sin AuthGuard');
  return user;
});
