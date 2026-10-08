import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', '..', 'src');
const LEDGER_REPOSITORY = join('src', 'wallets', 'ledger.repository.ts');

// Todos los archivos .ts de src/, recursivamente.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

// Qué archivos de src/ contienen una sentencia que cumple `pattern`.
const filesMatching = (pattern: RegExp): string[] =>
  sourceFiles(SRC)
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(join(SRC, '..'), file));

// R2 (enunciado 3.4): "los saldos no pueden modificarse directamente: todo cambio se origina en un movimiento del ledger".
// Esa regla se sostiene en el código si hay UN solo sitio que escribe saldos y movimientos. Esta prueba lo vigila:
// si alguien agrega otro UPDATE de wallets (o inserta movimientos por su cuenta), falla.
describe('único escritor del ledger', () => {
  it('solo LedgerRepository modifica el saldo de las wallets', () => {
    expect(filesMatching(/UPDATE\s+wallets\b/i)).toEqual([LEDGER_REPOSITORY]);
  });

  it('solo LedgerRepository inserta movimientos', () => {
    expect(filesMatching(/INSERT\s+INTO\s+ledger_entries\b/i)).toEqual([LEDGER_REPOSITORY]);
  });

  it('nadie borra wallets ni movimientos', () => {
    expect(filesMatching(/DELETE\s+FROM\s+(wallets|ledger_entries)\b/i)).toEqual([]);
  });

  it('el patrón detecta de verdad (si no, las pruebas anteriores pasarían sin vigilar nada)', () => {
    expect(/UPDATE\s+wallets\b/i.test('UPDATE   wallets SET available = 1')).toBe(true);
    expect(/UPDATE\s+wallets\b/i.test('update wallets\n  set held = 1')).toBe(true);
    expect(/UPDATE\s+wallets\b/i.test('SELECT * FROM wallets')).toBe(false);
  });
});
