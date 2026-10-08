import { validationError } from '../errors/validation-error';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// `limit` de los listados: un entero de 1 a 200, por defecto 50. Es un conteo, no un monto, así que aquí Number es correcto.
// Se valida a mano con una regex estricta: Number('1e2'), Number('') o Number(' 5 ') darían valores "válidos" que no queremos.
export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^[1-9]\d{0,2}$/.test(raw) || Number(raw) > MAX_LIMIT) {
    throw validationError('limit', `limit debe ser un entero entre 1 y ${MAX_LIMIT}`);
  }
  return Number(raw);
}
