-- 001_schema.sql
-- Fuente de verdad del esquema (ver CLAUDE.md). Los cambios posteriores van en migraciones nuevas.
-- Requiere PostgreSQL >= 13 por gen_random_uuid() nativo; el proyecto usa postgres:16.
--
-- Convenciones:
--   * Montos en numeric(28,8): 20 dígitos enteros y 8 decimales (precisión máxima del enunciado).
--   * Las tablas de auditoría (ledger, checks, decisiones, eventos) son de solo inserción: un trigger
--     rechaza UPDATE y DELETE. TRUNCATE no dispara triggers de fila; en producción se controla con
--     permisos (el rol de la app no tiene TRUNCATE) y las pruebas lo usan para limpiar la base.
--   * Las tablas append-only usan id bigint IDENTITY: now() es la hora de inicio de la transacción, así que
--     los movimientos de una misma operación empatan en created_at, y el id da un orden determinista.

-- ---------------------------------------------------------------------------
-- Usuarios y activos
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id          text PRIMARY KEY,
  role        text NOT NULL CHECK (role IN ('USER', 'COMPLIANCE')),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Permite que compliance_decisions exija por FK que el revisor tenga rol COMPLIANCE.
  UNIQUE (id, role)
);

-- Se quitó "decimals" del borrador: no lo usaba ninguna columna (todas son numeric(28,8)).
CREATE TABLE assets (
  code        text PRIMARY KEY,
  description text NOT NULL
);

-- ---------------------------------------------------------------------------
-- Wallets: saldo cacheado por activo. Solo cambia junto con un movimiento de ledger
-- en la misma transacción (lo garantiza la capa de aplicación; ver docs/plan.md).
-- ---------------------------------------------------------------------------

CREATE TABLE wallets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL REFERENCES users(id),
  asset_code  text NOT NULL REFERENCES assets(code),
  available   numeric(28,8) NOT NULL DEFAULT 0 CHECK (available >= 0),
  held        numeric(28,8) NOT NULL DEFAULT 0 CHECK (held >= 0),
  total       numeric(28,8) GENERATED ALWAYS AS (available + held) STORED,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, asset_code)
);

-- ---------------------------------------------------------------------------
-- Cotizaciones. price = unidades de origen por 1 unidad de destino (2500 USDT por 1 XAUT).
-- ---------------------------------------------------------------------------

CREATE TABLE quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL REFERENCES users(id),
  source_asset  text NOT NULL REFERENCES assets(code),
  target_asset  text NOT NULL REFERENCES assets(code),
  source_amount numeric(28,8) NOT NULL CHECK (source_amount > 0),
  price         numeric(28,8) NOT NULL CHECK (price > 0),
  fee_rate      numeric(7,6)  NOT NULL CHECK (fee_rate >= 0 AND fee_rate < 1),
  fee_amount    numeric(28,8) NOT NULL CHECK (fee_amount >= 0),
  net_amount    numeric(28,8) NOT NULL CHECK (net_amount > 0),
  target_amount numeric(28,8) NOT NULL CHECK (target_amount > 0),
  status        text NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE', 'EXPIRED', 'USED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  CHECK (source_asset <> target_asset),
  CHECK (expires_at > created_at),
  -- La base vuelve a verificar las reglas de cálculo (D5), y solo con sumas y multiplicaciones, que en numeric son exactas:
  -- comisión = source * fee_rate redondeada hacia arriba a 8 decimales.
  CHECK (fee_amount = ceil(source_amount * fee_rate * 100000000) / 100000000),
  CHECK (net_amount = source_amount - fee_amount),
  -- target = mayor múltiplo de 0,00000001 tal que target * price <= net (redondeo hacia abajo).
  -- Se expresa con multiplicaciones porque la división en numeric redondea el último dígito.
  CHECK (target_amount * price <= net_amount
         AND (target_amount + 0.00000001) * price > net_amount),
  -- Destino de la FK compuesta de exchanges: garantiza que el exchange y la cotización sean del mismo usuario.
  UNIQUE (id, user_id)
);

CREATE INDEX quotes_user_id_idx ON quotes (user_id);

-- ---------------------------------------------------------------------------
-- Intercambios. No copian montos ni precio: se leen de la cotización (D10), cuyas
-- columnas protege el trigger quotes_guard_update.
-- ---------------------------------------------------------------------------

CREATE TABLE exchanges (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            text NOT NULL REFERENCES users(id),
  quote_id           uuid NOT NULL,
  -- Se conserva para auditoría aunque la fila de idempotency_keys se borre al liberar la clave (D11).
  idempotency_key    text NOT NULL,
  status             text NOT NULL CHECK (status IN
                     ('PROCESSING', 'PENDING_REVIEW', 'COMPLETED', 'REJECTED', 'FAILED')),
  risk_level         text CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
  requires_follow_up boolean NOT NULL DEFAULT false,
  failure_reason     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (quote_id, user_id) REFERENCES quotes (id, user_id),
  -- Seguimiento solo para MEDIUM completada (COALESCE porque un CHECK con NULL pasa).
  CHECK (requires_follow_up = COALESCE(risk_level = 'MEDIUM' AND status = 'COMPLETED', false)),
  CHECK ((status = 'FAILED') = (failure_reason IS NOT NULL)),
  -- Fuera de PROCESSING y FAILED, el riesgo ya se conoce.
  CHECK (status IN ('PROCESSING', 'FAILED') OR risk_level IS NOT NULL),
  -- Solo HIGH pasa por revisión.
  CHECK (status NOT IN ('PENDING_REVIEW', 'REJECTED') OR risk_level = 'HIGH')
);

-- Una cotización no puede tener más de un intercambio vivo. Los FAILED se excluyen para que la
-- cotización pueda reintentarse tras una falla del servicio de cumplimiento (D7, D8).
CREATE UNIQUE INDEX exchanges_quote_live_uq ON exchanges (quote_id) WHERE status <> 'FAILED';
-- Defensa adicional de idempotencia: una clave no puede producir dos intercambios vivos.
CREATE UNIQUE INDEX exchanges_idem_live_uq ON exchanges (user_id, idempotency_key) WHERE status <> 'FAILED';
CREATE INDEX exchanges_user_idx ON exchanges (user_id, created_at DESC);
CREATE INDEX exchanges_pending_idx ON exchanges (created_at) WHERE status = 'PENDING_REVIEW';

-- ---------------------------------------------------------------------------
-- Idempotencia de POST /exchanges. response_status NULL = la petición original sigue en curso.
-- Es mutable: la fila se borra cuando la clave se libera (resultados transitorios, D11).
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  user_id         text NOT NULL REFERENCES users(id),
  key             text NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  request_hash    text NOT NULL,
  exchange_id     uuid REFERENCES exchanges(id),
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key),
  CHECK ((response_status IS NULL) = (response_body IS NULL))
);

-- ---------------------------------------------------------------------------
-- Ledger simplificado por wallet (D1, D2). Solo DEBIT/CREDIT; balance_type indica qué saldo
-- de la wallet se mueve. Retener = DEBIT AVAILABLE + CREDIT HELD; liberar = lo inverso.
-- balance_before/after se refieren al saldo indicado por balance_type.
-- ---------------------------------------------------------------------------

CREATE TABLE ledger_entries (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_id      uuid NOT NULL REFERENCES wallets(id),
  reference_type text NOT NULL CHECK (reference_type IN ('EXCHANGE', 'INITIAL_DEPOSIT')),
  exchange_id    uuid REFERENCES exchanges(id),
  entry_type     text NOT NULL CHECK (entry_type IN ('DEBIT', 'CREDIT')),
  balance_type   text NOT NULL CHECK (balance_type IN ('AVAILABLE', 'HELD')),
  amount         numeric(28,8) NOT NULL CHECK (amount > 0),
  balance_before numeric(28,8) NOT NULL CHECK (balance_before >= 0),
  balance_after  numeric(28,8) NOT NULL CHECK (balance_after >= 0),
  -- Los movimientos se crean ya confirmados dentro de la transacción de la operación; no hay pendientes.
  status         text NOT NULL DEFAULT 'CONFIRMED' CHECK (status = 'CONFIRMED'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((reference_type = 'EXCHANGE') = (exchange_id IS NOT NULL)),
  -- La aritmética del movimiento tiene que cuadrar.
  CHECK (balance_after = CASE entry_type
                           WHEN 'DEBIT'  THEN balance_before - amount
                           ELSE               balance_before + amount
                         END),
  -- Una operación no puede generar dos veces el mismo movimiento en la misma wallet.
  -- Revisado contra todos los flujos (LOW/MEDIUM, HIGH, aprobación, rechazo): ninguno repite la combinación.
  UNIQUE (exchange_id, wallet_id, entry_type, balance_type)
);

-- El UNIQUE anterior no aplica a filas con exchange_id NULL; el depósito inicial se protege aparte.
CREATE UNIQUE INDEX ledger_initial_deposit_uq ON ledger_entries (wallet_id)
  WHERE reference_type = 'INITIAL_DEPOSIT';
CREATE INDEX ledger_wallet_idx   ON ledger_entries (wallet_id, id DESC);
CREATE INDEX ledger_exchange_idx ON ledger_entries (exchange_id);

-- ---------------------------------------------------------------------------
-- Cumplimiento
-- ---------------------------------------------------------------------------

-- Una fila por consulta al servicio de cumplimiento, sea exitosa o fallida.
CREATE TABLE compliance_checks (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exchange_id      uuid NOT NULL REFERENCES exchanges(id),
  provider         text NOT NULL,
  outcome          text NOT NULL CHECK (outcome IN ('OK', 'ERROR')),
  risk_level       text CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
  request_payload  jsonb NOT NULL,
  response_payload jsonb,
  error_message    text,
  duration_ms      int CHECK (duration_ms >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'OK') = (risk_level IS NOT NULL)),
  CHECK ((outcome = 'ERROR') = (error_message IS NOT NULL))
);

CREATE INDEX compliance_checks_exchange_idx ON compliance_checks (exchange_id);

-- Decisión humana sobre una operación HIGH. Se mantiene explícita (D10) por la trazabilidad que pide el enunciado.
CREATE TABLE compliance_decisions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exchange_id   uuid NOT NULL UNIQUE REFERENCES exchanges(id),
  reviewer_id   text NOT NULL,
  -- Segregación de funciones en la base: la FK compuesta exige que el revisor tenga rol COMPLIANCE.
  reviewer_role text NOT NULL DEFAULT 'COMPLIANCE' CHECK (reviewer_role = 'COMPLIANCE'),
  decision      text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  reason        text,
  decided_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (reviewer_id, reviewer_role) REFERENCES users (id, role),
  -- El motivo es obligatorio al rechazar (D14).
  CHECK (decision = 'APPROVED' OR length(btrim(coalesce(reason, ''))) > 0)
);

-- ---------------------------------------------------------------------------
-- Historial de transiciones de cada intercambio. actor_id NULL = sistema.
-- ---------------------------------------------------------------------------

CREATE TABLE exchange_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exchange_id uuid NOT NULL REFERENCES exchanges(id),
  from_status text CHECK (from_status IN
              ('PROCESSING', 'PENDING_REVIEW', 'COMPLETED', 'REJECTED', 'FAILED')),
  to_status   text NOT NULL CHECK (to_status IN
              ('PROCESSING', 'PENDING_REVIEW', 'COMPLETED', 'REJECTED', 'FAILED')),
  actor_id    text REFERENCES users(id),
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX exchange_events_exchange_idx ON exchange_events (exchange_id, id);

-- ---------------------------------------------------------------------------
-- Triggers de integridad
-- ---------------------------------------------------------------------------

-- Tablas de solo inserción.
CREATE FUNCTION forbid_update_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER compliance_checks_append_only BEFORE UPDATE OR DELETE ON compliance_checks
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER compliance_decisions_append_only BEFORE UPDATE OR DELETE ON compliance_decisions
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER exchange_events_append_only BEFORE UPDATE OR DELETE ON exchange_events
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- Wallets, cotizaciones e intercambios cambian de estado, pero no se borran.
CREATE TRIGGER wallets_no_delete BEFORE DELETE ON wallets
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER quotes_no_delete BEFORE DELETE ON quotes
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER exchanges_no_delete BEFORE DELETE ON exchanges
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- Toda wallet nace en cero: el saldo inicial entra como movimiento INITIAL_DEPOSIT (D2).
CREATE FUNCTION wallets_start_empty() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.available <> 0 OR NEW.held <> 0 THEN
    RAISE EXCEPTION 'wallets must be created with zero balance; use a ledger entry'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wallets_start_empty BEFORE INSERT ON wallets
  FOR EACH ROW EXECUTE FUNCTION wallets_start_empty();

-- Cotización: precio, comisión y montos son inmutables (D10). Solo cambia status, y solo
-- ACTIVE -> EXPIRED o ACTIVE -> USED (D4: una USED nunca vuelve).
CREATE FUNCTION quotes_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.user_id, NEW.source_asset, NEW.target_asset, NEW.source_amount, NEW.price,
      NEW.fee_rate, NEW.fee_amount, NEW.net_amount, NEW.target_amount, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.user_id, OLD.source_asset, OLD.target_asset, OLD.source_amount, OLD.price,
      OLD.fee_rate, OLD.fee_amount, OLD.net_amount, OLD.target_amount, OLD.created_at, OLD.expires_at)
  THEN
    RAISE EXCEPTION 'quote % is immutable except for status', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status <> OLD.status
     AND NOT (OLD.status = 'ACTIVE' AND NEW.status IN ('EXPIRED', 'USED')) THEN
    RAISE EXCEPTION 'invalid quote transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER quotes_guard_update BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION quotes_guard_update();

-- Intercambio: identidad inmutable y máquina de estados (D3) aplicada también en la base.
--   PROCESSING     -> COMPLETED | PENDING_REVIEW | FAILED
--   PENDING_REVIEW -> COMPLETED | REJECTED
--   COMPLETED, REJECTED y FAILED son terminales.
--   Todo intercambio nace en PROCESSING.
CREATE FUNCTION exchanges_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PROCESSING' THEN
      RAISE EXCEPTION 'exchanges must be created in PROCESSING, got %', NEW.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.user_id, NEW.quote_id, NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.user_id, OLD.quote_id, OLD.idempotency_key, OLD.created_at)
  THEN
    RAISE EXCEPTION 'exchange % identity columns are immutable', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PROCESSING'     AND NEW.status IN ('COMPLETED', 'PENDING_REVIEW', 'FAILED'))
    OR (OLD.status = 'PENDING_REVIEW' AND NEW.status IN ('COMPLETED', 'REJECTED'))
  ) THEN
    RAISE EXCEPTION 'invalid exchange transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER exchanges_guard BEFORE INSERT OR UPDATE ON exchanges
  FOR EACH ROW EXECUTE FUNCTION exchanges_guard();
