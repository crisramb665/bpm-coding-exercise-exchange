-- 002_seed.sql
-- Datos iniciales (enunciado 3.3). Las pruebas vuelven a ejecutar este archivo tras cada TRUNCATE
-- (docs/plan.md §2), así que no debe depender de nada fuera de 001_schema.sql.

INSERT INTO assets (code, description) VALUES
  ('USDT-SBX', 'Activo simulado utilizado como medio de pago'),
  ('XAUT-SBX', 'Activo simulado representativo de oro');

INSERT INTO users (id, role, name) VALUES
  ('user-001',       'USER',       'Usuario de prueba'),
  ('compliance-001', 'COMPLIANCE', 'Oficial de cumplimiento de prueba');

-- Todas las wallets nacen en cero: un trigger rechaza cualquier saldo inicial (D2).
INSERT INTO wallets (user_id, asset_code)
SELECT u.id, a.code FROM users u CROSS JOIN assets a;

-- Saldo inicial de user-001: un CREDIT con referencia INITIAL_DEPOSIT, no un saldo escrito a mano (D2, R2).
-- El UPDATE y el INSERT van en una sola sentencia para que balance_before/after salgan del saldo real.
WITH moved AS (
  UPDATE wallets
     SET available = available + 10000, updated_at = now()
   WHERE user_id = 'user-001' AND asset_code = 'USDT-SBX'
  RETURNING id, available
)
INSERT INTO ledger_entries (wallet_id, reference_type, entry_type, balance_type, amount, balance_before, balance_after)
SELECT id, 'INITIAL_DEPOSIT', 'CREDIT', 'AVAILABLE', 10000, available - 10000, available
  FROM moved;
