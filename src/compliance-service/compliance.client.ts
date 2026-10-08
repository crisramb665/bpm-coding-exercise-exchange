import { Inject, Injectable } from '@nestjs/common';
import {
  COMPLIANCE_PROVIDER,
  COMPLIANCE_TIMEOUT_MS,
  ComplianceProvider,
  ComplianceRequest,
  ComplianceResult,
  RISK_LEVELS,
} from './compliance.types';

// Envuelve al proveedor con lo que la lógica principal necesita de CUALQUIER servicio externo: un tiempo máximo de
// espera, medición de la duración, validación de la respuesta y un resultado uniforme que nunca lanza.
// Se llama FUERA de toda transacción de base de datos (docs/plan.md §5): no hay bloqueos tomados mientras se espera.
// Sin reintentos, circuit breaker ni colas: el enunciado no los exige; la estrategia de producción va en el README.
@Injectable()
export class ComplianceClient {
  constructor(
    @Inject(COMPLIANCE_PROVIDER) private readonly provider: ComplianceProvider,
    @Inject(COMPLIANCE_TIMEOUT_MS) private readonly timeoutMs: number,
  ) {}

  async assess(request: ComplianceRequest): Promise<ComplianceResult> {
    const started = performance.now(); // reloj monotónico: no le afectan los cambios de hora del sistema
    const duration = (): number => Math.round(performance.now() - started);

    try {
      const response = await withTimeout(this.provider.assess(request), this.timeoutMs);

      // Un proveedor real podría responder cualquier cosa: no se confía en la forma, se valida.
      if (!response || !RISK_LEVELS.includes(response.riskLevel)) {
        throw new Error(`Respuesta inválida del proveedor: ${JSON.stringify(response)}`);
      }
      return {
        outcome: 'OK',
        provider: this.provider.name,
        riskLevel: response.riskLevel,
        requestPayload: request,
        responsePayload: response,
        durationMs: duration(),
      };
    } catch (err) {
      return {
        outcome: 'ERROR',
        provider: this.provider.name,
        errorMessage: err instanceof Error ? err.message : String(err),
        requestPayload: request,
        durationMs: duration(),
      };
    }
  }
}

// Rechaza si `promise` no termina en `ms`. Promise.race deja enganchada la promesa original, así que si el proveedor
// falla DESPUÉS del timeout no queda un rechazo sin manejar que tumbe el proceso. El temporizador siempre se limpia.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`El servicio de cumplimiento no respondió en ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
