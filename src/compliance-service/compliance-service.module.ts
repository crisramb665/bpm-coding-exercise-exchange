import { Module } from '@nestjs/common';
import { ComplianceClient } from './compliance.client';
import { COMPLIANCE_PROVIDER, COMPLIANCE_TIMEOUT_MS } from './compliance.types';
import { MockComplianceProvider } from './mock-compliance.provider';

const DEFAULT_TIMEOUT_MS = 2000;

// COMPLIANCE_TIMEOUT_MS: tiempo máximo de espera al servicio (S7). Debe ser mucho menor que el umbral de recuperación de
// operaciones huérfanas (D9). Un valor inválido hace fallar el arranque en lugar de dejar la espera sin límite.
function readTimeoutMs(): number {
  const raw = process.env.COMPLIANCE_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS);
  if (!/^[1-9]\d{0,5}$/.test(raw)) {
    throw new Error(`COMPLIANCE_TIMEOUT_MS debe ser un entero positivo de hasta 6 dígitos, recibió "${raw}"`);
  }
  return Number(raw); // milisegundos, no un monto
}

// SERVICIO AUTOMÁTICO de monitoreo transaccional (enunciado 3.7): responde LOW / MEDIUM / HIGH según el monto.
// NO es el rol COMPLIANCE. La persona que aprueba o rechaza las operaciones HIGH vive en `compliance-review/` (T14),
// se identifica con X-User-Id y no tiene relación de código con este módulo; solo se encuentran en el dato
// `exchanges.risk_level` / el estado PENDING_REVIEW. Ver docs/spec.md D19.
//
// El proveedor es un token: para pasar a un servicio real basta cambiar `useClass`, o sustituirlo en las pruebas
// con overrideProvider(COMPLIANCE_PROVIDER).
@Module({
  providers: [
    { provide: COMPLIANCE_PROVIDER, useClass: MockComplianceProvider },
    { provide: COMPLIANCE_TIMEOUT_MS, useFactory: readTimeoutMs },
    ComplianceClient,
  ],
  exports: [ComplianceClient],
})
export class ComplianceServiceModule {}
