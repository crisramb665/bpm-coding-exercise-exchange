import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { BusinessError, toErrorBody } from './business-error';

// Formato de error de toda la API (docs/spec.md §5): { "error": { "code", "message", "details"? } }.
// Solo captura BusinessError; el resto de excepciones (404 de ruta inexistente, 500) siguen el comportamiento por defecto de Nest.
@Catch(BusinessError)
export class BusinessErrorFilter implements ExceptionFilter {
  catch(error: BusinessError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<{
      status(code: number): { json(body: unknown): void };
    }>();
    res.status(error.httpStatus).json(toErrorBody(error));
  }
}
