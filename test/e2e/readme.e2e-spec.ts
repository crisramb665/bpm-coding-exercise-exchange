import { INestApplication } from '@nestjs/common';
import Decimal from 'decimal.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { FEE_RATE, PRICE } from '../../src/common/money/money';
import { setupSwagger } from '../../src/common/swagger/setup-swagger';
import { closeDb, createApp } from '../helpers';

// El README es lo primero que lee quien evalúa. Esta prueba lo cruza con el sistema real para que no afirme nada que ya no sea cierto:
// los diagramas, los enlaces, las rutas, los comandos, las variables, los usuarios, las decisiones citadas y las cifras.
const root = join(__dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const readme = read('README.md');
const spec = read('docs/spec.md');

// El diagrama de un .mmd sin sus comentarios de cabecera (%%).
const diagramOnly = (path: string): string =>
  read(path)
    .split('\n')
    .filter((line) => !line.trim().startsWith('%%'))
    .join('\n')
    .trim();

// Todo el código fuente de src/, concatenado (para buscar qué variables de entorno lee).
function sourceCode(dir = join(root, 'src')): string {
  return readdirSync(dir)
    .map((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sourceCode(path) : path.endsWith('.ts') ? readFileSync(path, 'utf8') : '';
    })
    .join('\n');
}

describe('README', () => {
  let app: INestApplication;
  let apiRoutes: string[];

  beforeAll(async () => {
    app = await createApp({ beforeInit: setupSwagger });
    const doc = (await request(app.getHttpServer()).get('/docs-json').expect(200)).body as { paths: Record<string, Record<string, unknown>> };
    apiRoutes = Object.entries(doc.paths).flatMap(([path, methods]) => Object.keys(methods).map((m) => `${m.toUpperCase()} ${path.replace(/\{id\}/g, ':id')}`));
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  describe('diagramas incrustados', () => {
    const blocks = [...readme.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1].trim());

    it('incrusta la arquitectura y el flujo, idénticos a sus archivos .mmd (si se edita uno, hay que actualizar el otro)', () => {
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toBe(diagramOnly('docs/diagram.mmd'));
      expect(blocks[1]).toBe(diagramOnly('docs/diagram-exchange-flow.mmd'));
    });
  });

  it('todos sus enlaces relativos apuntan a archivos que existen', () => {
    const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((target) => !/^(https?:|#|mailto:)/.test(target));
    expect(links.length).toBeGreaterThan(10);
    for (const link of links) {
      const file = link.split('#')[0];
      expect({ link, existe: existsSync(join(root, file)) }).toEqual({ link, existe: true });
    }
  });

  describe('ejecución en tres comandos', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string>; engines: { node: string }; packageManager: string }).scripts;

    it('el primer bloque de código del README son exactamente los tres comandos, en orden, y existen en package.json', () => {
      // Se mira ese bloque y no el README entero: «pnpm run up» aparece en varias frases y no probaría nada.
      const firstBlock = readme.match(/```bash\n([\s\S]*?)```/)![1];
      const commands = firstBlock.split('\n').filter((line) => line.trim()).map((line) => line.split('#')[0].trim());
      expect(commands).toEqual(['pnpm install', 'pnpm run up', 'pnpm test']);
      expect(scripts.up).toBeDefined();
      expect(scripts.test).toBeDefined();
    });

    it('`pnpm run up` levanta la base, migra y arranca (como dice el README); `pnpm test` levanta la base', () => {
      expect(scripts.up).toBe('pnpm run db:up && pnpm run migrate && pnpm run start');
      expect(scripts.test).toContain('pnpm run db:up');
      expect(scripts['db:up']).toContain('docker compose up -d --wait');
    });

    it('los puertos y la versión de Node que dice el README son los reales', () => {
      expect(readme).toContain('puerto **5433**');
      expect(read('docker-compose.yml')).toContain('"5433:5432"');
      expect(read('docker-compose.yml')).toContain('postgres:16');
      expect(readme).toContain('http://localhost:3000');
      expect(read('.env.example')).toContain('PORT=3000');
      expect(readme).toContain('**Node 22**');
      expect(read('.nvmrc').trim()).toBe('22');
    });

    it('las variables de entorno de la tabla son las de .env.example, con sus valores por defecto, y el código las lee', () => {
      const documented = new Map([...readme.matchAll(/^\| `([A-Z_]+)` \| `([^`]+)` \|/gm)].map((m) => [m[1], m[2]]));
      const example = new Map(
        read('.env.example')
          .split('\n')
          .filter((line) => /^[A-Z_]+=/.test(line))
          .map((line) => [line.split('=')[0], line.slice(line.indexOf('=') + 1)] as [string, string]),
      );
      expect([...documented.keys()].sort()).toEqual([...example.keys()].sort());
      for (const [name, value] of documented) expect({ name, value }).toEqual({ name, value: example.get(name) });

      const code = sourceCode();
      for (const name of documented.keys()) expect({ name, loLee: code.includes(`process.env.${name}`) }).toEqual({ name, loLee: true });
    });
  });

  describe('usuarios de prueba', () => {
    const seed = read('migrations/002_seed.sql');

    it('los usuarios y roles de la tabla son los de la semilla, y user-001 recibe 10.000 USDT', () => {
      expect(seed).toMatch(/\('user-001',\s+'USER'/);
      expect(seed).toMatch(/\('compliance-001',\s+'COMPLIANCE'/);
      expect(seed).toContain('available + 10000');
      expect(readme).toMatch(/\| `user-001` \| USER \| 10\.000 \| 0 \|/);
      expect(readme).toMatch(/\| `compliance-001` \| COMPLIANCE \| 0 \| 0 \|/);
    });
  });

  describe('la API', () => {
    it('la tabla de endpoints lista exactamente las 9 rutas reales', () => {
      const documented = [...readme.matchAll(/^\| `(GET|POST|PATCH) (\/[^`]+)` \|/gm)].map((m) => `${m[1]} ${m[2]}`);
      expect(documented.sort()).toEqual([...apiRoutes].sort());
    });

    it('los ejemplos con curl solo llaman a rutas que existen', () => {
      // Las 9 rutas de negocio, más /docs (Swagger UI), que no es una ruta de negocio pero el README la nombra.
      const patterns = [...apiRoutes.map((route) => route.split(' ')[1].replace(/:id/g, '[^/\\s"?]+')), '/docs'];
      const calls = [...readme.matchAll(/localhost:3000(\/[^\s'"*]*)/g)].map((m) => m[1].replace(/\?.*$/, ''));
      expect(calls.length).toBeGreaterThanOrEqual(8);
      for (const path of calls) {
        expect({ path, existe: patterns.some((p) => new RegExp(`^${p}$`).test(path)) }).toEqual({ path, existe: true });
      }
    });

    it('las cifras del resumen son las reglas reales: precio 2.500, comisión 1 %, vigencia 30 s', () => {
      expect(PRICE.toString()).toBe('2500');
      expect(FEE_RATE.toString()).toBe('0.01');
      expect(readme).toContain('precio 2.500, comisión 1 %, vigencia 30 s');
      expect(read('.env.example')).toContain('QUOTE_TTL_SECONDS=30');
    });
  });

  describe('decisiones citadas', () => {
    const table = readme.slice(readme.indexOf('## 7. Decisiones técnicas'), readme.indexOf('## 8. Concurrencia'));
    const specDecisions = new Set([...spec.matchAll(/^\*\*D(\d+)\./gm)].map((m) => Number(m[1])));
    const cited = [...table.matchAll(/\bD(\d+)\b/g)].map((m) => Number(m[1]));

    it('toda decisión que cita el README existe en la spec', () => {
      expect(cited.length).toBeGreaterThanOrEqual(15);
      for (const n of new Set(cited)) expect({ decision: `D${n}`, existe: specDecisions.has(n) }).toEqual({ decision: `D${n}`, existe: true });
    });

    it('cita las decisiones que el enunciado obliga a explicar en el README (D2: tesorería; D9: recuperación)', () => {
      for (const n of [2, 9, 17, 18, 19]) expect(cited).toContain(n);
    });
  });

  describe('contiene lo que exige el enunciado para el README (sección 9.2 y 3.x)', () => {
    it('las seis respuestas de diseño (a-f) están escritas', () => {
      const answers = readme.slice(readme.indexOf('## 13. Respuestas'), readme.indexOf('## 14. Uso de inteligencia'));
      for (const letter of ['a) Emisión', 'b) Transferencias', 'c) Conciliar', 'd) Indisponibilidad', 'e) Controles', 'f) Emisión on-chain']) {
        expect(answers).toContain(`**${letter}`);
      }
    });

    it.each([
      ['arquitectura', /^## 4\. Arquitectura/m],
      ['tecnologías seleccionadas', /^## 5\. Tecnologías/m],
      ['instalación y ejecución', /^## 1\. Ejecución en tres comandos/m],
      ['inicialización de la base de datos', /\*\*Inicialización de la base de datos\.\*\*/],
      ['ejecución de pruebas', /pnpm test /],
      ['usuarios de prueba', /^## 2\. Usuarios de prueba/m],
      ['ejemplos de consumo de la API', /^### Ejemplos de consumo/m],
      ['supuestos', /\*\*Supuestos\*\*/],
      ['limitaciones', /\*\*Limitaciones conocidas:\*\*/],
      ['decisiones técnicas', /^## 7\. Decisiones técnicas/m],
      ['mejoras necesarias para producción', /^## 10\. Mejoras necesarias para producción/m],
      ['respuestas a las preguntas de diseño', /^## 13\. Respuestas a las preguntas de diseño/m],
      ['herramientas de IA utilizadas', /^## 14\. Uso de inteligencia artificial/m],
      ['tiempo aproximado empleado', /\*\*Tiempo aproximado empleado:\*\*/],
      ['3.2: cómo se sustituiría la autenticación en producción', /\*\*Cómo se sustituiría en producción\.\*\*/],
      ['3.4: cómo evolucionaría hacia partida doble', /^## 11\. Evolución hacia un ledger de partida doble/m],
      ['3.7: estrategia de producción si falla cumplimiento', /\*\*Si el servicio de cumplimiento falla\*\*/],
      ['3.10: cómo se evita que dos solicitudes consuman el mismo saldo', /\*\*Cómo se evita que dos solicitudes simultáneas consuman el mismo saldo\.\*\*/],
      ['el mockup', /^## 12\. Mockup/m],
    ])('%s', (_name, pattern) => {
      expect(readme).toMatch(pattern);
    });

    it('la partida doble del ejemplo suma cero por activo', () => {
      const rows = [...readme.matchAll(/^\| (Wallet del usuario|Tesorería|Ingresos por comisiones|Proveedor de liquidez) \| (USDT-SBX|XAUT-SBX) \| ([−+])([\d.,]+) \|/gm)];
      expect(rows.length).toBe(5);
      const sums = new Map<string, Decimal>();
      for (const [, , asset, sign, amount] of rows) {
        const value = new Decimal(amount.replaceAll('.', '').replace(',', '.'));
        sums.set(asset, (sums.get(asset) ?? new Decimal(0)).plus(sign === '−' ? value.neg() : value));
      }
      expect([...sums.entries()].map(([asset, sum]) => [asset, sum.toString()])).toEqual([['USDT-SBX', '0'], ['XAUT-SBX', '0']]);
    });
  });

  // Tripwire deliberado: una sección está pendiente por plan (docs/tasks.md T23: el tiempo total). Cuando se complete, esta prueba falla
  // y obliga a actualizarla: el README no puede darse por terminado con marcadores pendientes.
  it('el único marcador pendiente es el de la T23 (tiempo total)', () => {
    const pending = [...readme.matchAll(/⏳ \*\*Pendiente \((T\d+)\)/g)].map((m) => m[1]);
    expect(pending).toEqual(['T23']);
    expect(readme).not.toMatch(/\bTODO\b|FIXME|lorem ipsum/); // sensible a mayúsculas: «todo» es una palabra normal en español
  });
});
