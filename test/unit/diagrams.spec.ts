import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
// El diagrama sin sus comentarios (%%): los comentarios de la cabecera también nombran los elementos ("wallets y ledger") y
// harían que una prueba pasara aunque el nodo se hubiera borrado del dibujo.
const diagramOnly = (path: string): string =>
  read(path)
    .split('\n')
    .filter((line) => !line.trim().startsWith('%%'))
    .join('\n');

// Los diagramas son documentación, pero el modelo de datos tiene una fuente de verdad (migrations/001_schema.sql). Estas
// pruebas evitan que el diagrama ER, o la lista de elementos pedidos por el enunciado, se desvíen sin que nadie lo note.
describe('diagramas', () => {
  const schema = read('migrations/001_schema.sql');
  const er = read('docs/diagram-er.mmd');

  // Las tablas del esquema, cada una con el texto de su CREATE TABLE.
  const tables = new Map<string, string>(
    [...schema.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)].map((m) => [m[1], m[2]]),
  );

  // Las entidades del ER: nombre y columnas que declara.
  const entities = new Map<string, string[]>(
    [...er.matchAll(/^ {2}(\w+) \{\n([\s\S]*?)^ {2}\}/gm)].map((m) => [
      m[1],
      m[2].split('\n').map((line) => line.trim().split(/\s+/)[1]).filter(Boolean),
    ]),
  );

  describe('diagrama ER (diagram-er.mmd)', () => {
    it('el esquema tiene las 10 tablas esperadas (para que esta prueba no sea vacía)', () => {
      expect([...tables.keys()].sort()).toEqual(
        ['assets', 'compliance_checks', 'compliance_decisions', 'exchange_events', 'exchanges', 'idempotency_keys', 'ledger_entries', 'quotes', 'users', 'wallets'],
      );
    });

    it('dibuja exactamente las tablas del esquema, ni una más ni una menos', () => {
      expect([...entities.keys()].sort()).toEqual([...tables.keys()].sort());
    });

    it.each([...entities.entries()])('%s: cada columna del diagrama existe en la tabla real', (table, columns) => {
      expect(columns.length).toBeGreaterThan(0);
      for (const column of columns) {
        expect({ table, column, existe: new RegExp(`\\b${column}\\b`).test(tables.get(table) ?? '') }).toEqual({ table, column, existe: true });
      }
    });

    it('toda relación mencionada une tablas que existen', () => {
      const relations = [...er.matchAll(/^ {2}(\w+) [|o}{]+--[|o}{]+ (\w+) :/gm)];
      expect(relations.length).toBeGreaterThanOrEqual(12);
      for (const [, from, to] of relations) {
        expect([from, tables.has(from), to, tables.has(to)]).toEqual([from, true, to, true]);
      }
    });
  });

  describe('diagrama de arquitectura (diagram.mmd): los elementos que pide el enunciado (9.3)', () => {
    const architecture = diagramOnly('docs/diagram.mmd').toLowerCase();
    // El contenido de cada subgrafo (hasta su `end`): lo que importa no es que la palabra aparezca en cualquier sitio
    // (p. ej. "GET /wallets" es una ruta), sino que wallets y ledger estén DENTRO de la base de datos, y los servicios dentro de la API.
    const block = (name: string): string => architecture.match(new RegExp(`subgraph ${name}[^\\n]*\\n([\\s\\S]*?)\\n {2}end`))?.[1] ?? '';

    it('tiene los dos actores: el usuario y el oficial con rol de Cumplimiento', () => {
      expect(architecture).toMatch(/usuario<br\/>\(rol user\)/);
      expect(architecture).toMatch(/oficial de cumplimiento<br\/>\(rol compliance\)/);
    });

    it.each([
      ['servicio de cotización', /servicio de cotización/],
      ['la revisión de Cumplimiento', /revisión de cumplimiento/],
      ['el cliente del servicio de cumplimiento', /cliente de cumplimiento/],
      ['el único punto que mueve saldos', /ledgerrepository/],
    ])('la API (subgrafo) contiene: %s', (_name, pattern) => {
      expect(block('api')).toMatch(pattern);
    });

    it.each([
      ['wallets', /wallets/],
      ['ledger', /ledger/],
    ])('la base de datos (subgrafo) contiene: %s', (_name, pattern) => {
      expect(block('db')).toMatch(pattern);
    });

    it('el servicio MOCK de cumplimiento está FUERA de la API y de la base de datos', () => {
      expect(block('api')).not.toMatch(/servicio mock/);
      expect(block('db')).not.toMatch(/servicio mock/);
      expect(architecture).toMatch(/servicio mock/);
    });

    it('los subgrafos existen (si no, las comprobaciones anteriores no probarían nada)', () => {
      expect(block('api').length).toBeGreaterThan(100);
      expect(block('db').length).toBeGreaterThan(100);
    });
  });

  describe('diagrama de flujo (diagram-exchange-flow.mmd)', () => {
    const flow = diagramOnly('docs/diagram-exchange-flow.mmd');

    it.each(['Tx1', 'Tx2', 'PROCESSING', 'PENDING_REVIEW', 'COMPLETED', 'FAILED', 'REJECTED', 'Idempotency-Key', 'FOR UPDATE', 'Fuera de toda transacción'])('menciona %s', (text) => {
      expect(flow).toContain(text);
    });
  });
});
