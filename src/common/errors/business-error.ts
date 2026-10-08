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
