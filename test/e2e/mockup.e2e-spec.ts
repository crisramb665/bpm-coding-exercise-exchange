import { INestApplication } from '@nestjs/common';
import Decimal from 'decimal.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { calculateQuote, formatAmount } from '../../src/common/money/money';
import { setupSwagger } from '../../src/common/swagger/setup-swagger';
import { closeDb, createApp } from '../helpers';

// El enunciado (sección 8) dice que del mockup se evalúa "la coherencia entre el mockup, las reglas del caso y los estados del
// backend". Esta prueba lo verifica contra el sistema REAL: el mockup solo puede nombrar endpoints, estados y códigos de error
// que existen de verdad, tiene que usar todos los de cara al usuario, y sus cifras tienen que salir de las reglas de cálculo.
const root = join(__dirname, '..', '..');
const html = readFileSync(join(root, 'docs/mockup/mockup.html'), 'utf8');
const schema = readFileSync(join(root, 'migrations/001_schema.sql'), 'utf8');

// Cada pantalla como texto plano (sin estilos, comentarios ni etiquetas).
function screenText(id: string): string {
  const section = html.match(new RegExp(`<section class="screen" id="${id}">([\\s\\S]*?)</section>`))?.[1] ?? '';
  return section
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

// Los valores de un atributo data-* en todo el mockup.
const dataValues = (attribute: string): Set<string> => new Set([...html.matchAll(new RegExp(`data-${attribute}="([^"]+)"`, 'g'))].map((m) => m[1]));

// Las formas en que el mockup escribe un monto: miles con punto y decimales con coma, con los 8 decimales («1,98000396») o sin los
// ceros finales («0,396», «990,00»).
function spanish(amount: string): { completo: string; corto: string } {
  const [intPart, frac = ''] = amount.split('.');
  const miles = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const sinCeros = frac.replace(/0+$/, '');
  return { completo: `${miles},${frac.padEnd(8, '0')}`, corto: `${miles},${sinCeros || '00'}` };
}
const shows = (text: string, amount: string): boolean => Object.values(spanish(amount)).some((form) => text.includes(form));

describe('mockup de baja fidelidad (docs/mockup/mockup.html)', () => {
  let app: INestApplication;
  let doc: { paths: Record<string, Record<string, { responses: Record<string, { description?: string }> }>> };

  beforeAll(async () => {
    app = await createApp({ beforeInit: setupSwagger });
    doc = (await request(app.getHttpServer()).get('/docs-json').expect(200)).body;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  const apiRoutes = (): string[] => Object.entries(doc.paths).flatMap(([path, methods]) => Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`));

  it('tiene las cuatro pantallas del enunciado', () => {
    expect([...html.matchAll(/<section class="screen" id="(s\d)">/g)].map((m) => m[1])).toEqual(['s1', 's2', 's3', 's4']);
  });

  describe('contiene lo que pide el enunciado en cada pantalla (sección 8)', () => {
    it.each([
      ['s1 · panel del usuario', 's1', ['USDT-SBX', 'XAUT-SBX', 'Disponible', 'Retenido', 'Total', 'Últimos movimientos', 'Solicitar intercambio']],
      ['s2 · solicitud de intercambio', 's2', ['Monto a pagar', 'Precio', 'Comisión', 'Recibirás', 'Vigencia de la cotización', 'Confirmar intercambio', 'VALIDATION_ERROR']],
      ['s3 · resultado de la operación', 's3', ['Operación completada', 'pendiente de revisión', 'rechazada', 'cotización venció', 'Saldo insuficiente']],
      ['s4 · bandeja de Cumplimiento', 's4', ['Usuario', 'Monto', 'Activo', 'Nivel de riesgo', 'Fecha', 'Aprobar', 'Rechazar']],
    ])('%s', (_name, id, required) => {
      const text = screenText(id);
      for (const element of required) expect({ element, presente: text.includes(element) }).toEqual({ element, presente: true });
    });

    it('las pantallas del usuario muestran el rol USER y la bandeja, el rol COMPLIANCE', () => {
      for (const id of ['s1', 's2', 's3']) expect(screenText(id)).toContain('rol USER');
      expect(screenText('s4')).toContain('rol COMPLIANCE');
    });
  });

  describe('coherencia con la API real', () => {
    it('todo endpoint que nombra el mockup existe en la API, y el mockup usa los 9', () => {
      expect([...dataValues('endpoint')].sort()).toEqual([...apiRoutes()].sort());
    });

    it('todo código de error que muestra el mockup está documentado en la API', () => {
      const documented = new Set(
        Object.values(doc.paths).flatMap((methods) =>
          Object.values(methods).flatMap((op) => Object.values(op.responses).flatMap((r) => r.description?.match(/[A-Z]+(?:_[A-Z]+)+/g) ?? [])),
        ),
      );
      documented.add('VALIDATION_ERROR');
      for (const code of dataValues('error')) expect({ code, documentado: documented.has(code) }).toEqual({ code, documentado: true });
    });

    it('no olvida ningún error de POST /quotes ni de POST /exchanges que el usuario pueda ver', () => {
      const shown = dataValues('error');
      // Errores que existen pero no tienen una pantalla propia, con la razón: no los provoca el usuario ni puede actuar sobre ellos.
      const withoutScreen: Record<string, string> = {
        IDEMPOTENCY_KEY_MISMATCH: 'solo ocurre si el cliente reutiliza una clave con otro contenido: es un error de programación del cliente',
        EXCHANGE_NOT_PROCESSING: 'solo ocurre si la recuperación de operaciones huérfanas actúa durante la operación: es operativo',
        QUOTE_NOT_FOUND: 'el cliente solo envía cotizaciones que acaba de recibir del propio servidor',
        UNAUTHENTICATED: 'la autenticación es de transporte; en producción la resuelve el proveedor de identidad',
        FORBIDDEN: 'cada rol solo ve las pantallas que le corresponden',
      };
      const codes = ['POST /quotes', 'POST /exchanges'].flatMap((route) => {
        const [method, path] = route.split(' ');
        // Solo las respuestas de ERROR (4xx y 5xx): la descripción del 201 también nombra estados (COMPLETED, PENDING_REVIEW).
        return Object.entries(doc.paths[path][method.toLowerCase()].responses)
          .filter(([status]) => Number(status) >= 400)
          .flatMap(([, r]) => r.description?.match(/[A-Z]+(?:_[A-Z]+)+/g) ?? []);
      });
      for (const code of new Set(codes)) {
        expect({ code, cubierto: shown.has(code) || code in withoutScreen }).toEqual({ code, cubierto: true });
      }
    });
  });

  describe('coherencia con los estados del backend', () => {
    const schemaStatuses = new Set(schema.match(/CREATE TABLE exchanges \([\s\S]*?status\s+text NOT NULL CHECK \(status IN\s*\(([^)]*)\)/)![1].match(/'([A-Z_]+)'/g)!.map((s) => s.replaceAll("'", '')));

    it('el esquema define los 5 estados (para que esta prueba no sea vacía)', () => {
      expect([...schemaStatuses].sort()).toEqual(['COMPLETED', 'FAILED', 'PENDING_REVIEW', 'PROCESSING', 'REJECTED']);
    });

    it('todo estado que muestra el mockup existe en la base de datos', () => {
      for (const status of dataValues('status')) expect({ status, existe: schemaStatuses.has(status) }).toEqual({ status, existe: true });
    });

    it('muestra todos los estados finales (PROCESSING es transitorio y no se muestra)', () => {
      expect([...dataValues('status')].sort()).toEqual(['COMPLETED', 'FAILED', 'PENDING_REVIEW', 'REJECTED']);
    });
  });

  describe('las cifras salen de las reglas de cálculo, no están inventadas', () => {
    it.each(['999.99', '1000', '2500', '5000.01', '6000', '7500'])('%s USDT-SBX → los XAUT-SBX que muestra son los que calcula el sistema', (source) => {
      const xaut = formatAmount(calculateQuote(source).targetAmount);
      expect({ source, xaut, aparece: shows(html, xaut) }).toEqual({ source, xaut, aparece: true });
    });

    it('la cotización de la pantalla 2 (1.000 USDT-SBX) muestra su comisión, su neto y su destino reales', () => {
      const { feeAmount, netAmount, targetAmount } = calculateQuote('1000');
      const text = screenText('s2');
      expect(text).toContain(`Comisión (1 %) ${spanish(formatAmount(feeAmount)).corto} USDT-SBX`);
      expect(text).toContain(`Monto neto a convertir ${spanish(formatAmount(netAmount)).corto} USDT-SBX`);
      expect(text).toContain(`${spanish(formatAmount(targetAmount)).corto} XAUT-SBX`);
      expect(text).toContain('1 XAUT-SBX = 2.500,00 USDT-SBX');
    });

    it('en el panel, disponible + retenido = total, y los movimientos cuadran (antes → después)', () => {
      const text = screenText('s1');
      const available = new Decimal('1500.00');
      const held = new Decimal('5000.01');
      expect(shows(text, available.toFixed(8))).toBe(true);
      expect(shows(text, held.toFixed(8))).toBe(true);
      expect(text).toContain(spanish(available.plus(held).toFixed(8)).completo); // el total que muestra es la suma
      // Retener 5.000,01: el disponible baja de 6.500,01 a 1.500,00 y el retenido sube de 0 a 5.000,01.
      expect(text).toContain('6.500,01 → 1.500,00');
      expect(text).toContain('0,00 → 5.000,01');
    });

    it('ningún usuario tiene retenido más de lo que puede tener (el saldo inicial es 10.000)', () => {
      const rows = [...html.matchAll(/<td>(user-\d+)<br>[\s\S]*?<td class="num">([\d.,]+)<\/td>/g)];
      const heldByUser = new Map<string, Decimal>();
      for (const [, user, amount] of rows) {
        heldByUser.set(user, (heldByUser.get(user) ?? new Decimal(0)).plus(amount.replaceAll('.', '').replace(',', '.')));
      }
      expect(rows.length).toBeGreaterThanOrEqual(3);
      for (const [user, total] of heldByUser) expect({ user, cabe: total.lte(10000) }).toEqual({ user, cabe: true });
    });
  });
});
