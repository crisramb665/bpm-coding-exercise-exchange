import { ComplianceProvider, ComplianceRequest, ComplianceResponse } from '../src/compliance-service/compliance.types';
import { MockComplianceProvider } from '../src/compliance-service/mock-compliance.provider';

// Proveedor de pruebas que envuelve al mock real y permite, por prueba, hacerlo fallar, retrasarlo, devolver basura o
// ejecutar código EN EL MEDIO de la consulta (donde el sistema real estaría esperando a un servicio externo).
export class ControllableProvider implements ComplianceProvider {
  readonly name = 'MOCK';
  mode: 'normal' | 'fail' | 'invalid' = 'normal';
  hook?: (request: ComplianceRequest) => Promise<void>;
  private readonly real = new MockComplianceProvider();

  async assess(req: ComplianceRequest): Promise<ComplianceResponse> {
    if (this.hook) await this.hook(req);
    if (this.mode === 'fail') throw new Error('servicio de cumplimiento caído');
    if (this.mode === 'invalid') return { riskLevel: 'CRITICAL' } as unknown as ComplianceResponse;
    return this.real.assess(req);
  }
  reset(): void {
    this.mode = 'normal';
    this.hook = undefined;
  }
}
