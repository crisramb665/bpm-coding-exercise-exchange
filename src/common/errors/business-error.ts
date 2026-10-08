// Error de negocio con un código estable (QUOTE_EXPIRED, INSUFFICIENT_FUNDS…) y el status HTTP definido
// en docs/spec.md §5. Lo traduce a JSON el BusinessErrorFilter.
export class BusinessError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// Cuerpo JSON de un error (docs/spec.md §5). Lo usan el filtro HTTP y las respuestas que se guardan para la idempotencia:
// una respuesta reproducida tiene que ser idéntica a la original, así que ambos deben construirla igual.
export function toErrorBody(error: BusinessError): { error: { code: string; message: string; details?: Record<string, unknown> } } {
  return { error: { code: error.code, message: error.message, ...(error.details && { details: error.details }) } };
}
