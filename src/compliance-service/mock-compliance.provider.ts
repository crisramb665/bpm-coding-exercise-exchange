import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { ComplianceProvider, ComplianceRequest, ComplianceResponse, RiskLevel } from './compliance.types';

// Umbrales del enunciado (3.7), PROPIOS de este mock a propósito: el servicio de cumplimiento es externo y la lógica
// principal no debe compartir con él ni código ni constantes. Solo se entienden por el contrato (compliance.types.ts).
const MEDIUM_FROM = new Decimal('1000'); // desde 1.000 (inclusive) es MEDIUM
const HIGH_ABOVE = new Decimal('5000'); // 5.000 aún es MEDIUM; HIGH es estrictamente mayor
const SUPPORTED_ASSET = 'USDT-SBX'; // los umbrales están definidos en USDT-SBX

// Riesgo según el monto de origen:  < 1.000 → LOW · 1.000 a 5.000 (ambos inclusive) → MEDIUM · > 5.000 → HIGH.
// Función pura y exportada para poder probar las fronteras sin pasar por la clase.
export function riskLevelForAmount(sourceAmount: string): RiskLevel {
  // new Decimal(string) conserva todos los dígitos y las comparaciones son exactas (la precisión solo afecta a las operaciones).
  const amount = new Decimal(sourceAmount);
  if (amount.lt(MEDIUM_FROM)) return 'LOW';
  if (amount.lte(HIGH_ABOVE)) return 'MEDIUM';
  return 'HIGH';
}

@Injectable()
export class MockComplianceProvider implements ComplianceProvider {
  readonly name = 'MOCK';
  private readonly alwaysFail: boolean;

  constructor() {
    // COMPLIANCE_MOCK_FAIL=true simula un servicio caído, para demostrar a mano el 503 y el estado FAILED (D7).
    this.alwaysFail = process.env.COMPLIANCE_MOCK_FAIL === 'true';
  }

  async assess(request: ComplianceRequest): Promise<ComplianceResponse> {
    if (this.alwaysFail) throw new Error('Servicio de cumplimiento simulado no disponible (COMPLIANCE_MOCK_FAIL=true)');
    if (request.sourceAsset !== SUPPORTED_ASSET) {
      throw new Error(`El mock solo evalúa montos en ${SUPPORTED_ASSET}, recibió ${request.sourceAsset}`);
    }
    return { riskLevel: riskLevelForAmount(request.sourceAmount) };
  }
}
