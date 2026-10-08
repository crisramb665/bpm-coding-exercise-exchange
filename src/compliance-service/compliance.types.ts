// Contrato con el servicio de monitoreo transaccional (enunciado 3.7). Es lo único que la lógica principal conoce
// del servicio: no sabe cómo decide el riesgo ni dónde corre. Hoy lo implementa un mock dentro de la aplicación;
// en producción sería un cliente HTTP de un proveedor externo (Chainalysis, Sumsub…) que cumpla esta misma interfaz.

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export const RISK_LEVELS: readonly RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH'];

// Lo que se le envía a evaluar. Los montos viajan como string (regla 3 de CLAUDE.md).
export interface ComplianceRequest {
  exchangeId: string;
  userId: string;
  sourceAsset: string;
  sourceAmount: string; // monto bruto de origen, comisión incluida (S1)
}

export interface ComplianceResponse {
  riskLevel: RiskLevel;
}

export interface ComplianceProvider {
  readonly name: string; // se guarda en compliance_checks.provider
  assess(request: ComplianceRequest): Promise<ComplianceResponse>;
}

export const COMPLIANCE_PROVIDER = Symbol('COMPLIANCE_PROVIDER');
export const COMPLIANCE_TIMEOUT_MS = Symbol('COMPLIANCE_TIMEOUT_MS');

// Resultado de consultar al servicio, con la forma de la tabla compliance_checks (una fila por consulta, sea buena o mala).
// El cliente nunca lanza: una falla o un timeout son un resultado ERROR que el flujo de intercambio sabe tratar (D7).
export type ComplianceResult =
  | {
      outcome: 'OK';
      provider: string;
      riskLevel: RiskLevel;
      requestPayload: ComplianceRequest;
      responsePayload: ComplianceResponse;
      durationMs: number;
    }
  | {
      outcome: 'ERROR';
      provider: string;
      errorMessage: string;
      requestPayload: ComplianceRequest;
      durationMs: number;
    };
