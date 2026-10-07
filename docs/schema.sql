CREATE TABLE users (
  id          text PRIMARY KEY,
  role        text NOT NULL CHECK (role IN ('USER','COMPLIANCE')),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assets (
  code        text PRIMARY KEY,
  decimals    int  NOT NULL DEFAULT 8,
  description text NOT NULL
);

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

CREATE TABLE quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL REFERENCES users(id),
  source_asset  text NOT NULL REFERENCES assets(code),
  target_asset  text NOT NULL REFERENCES assets(code),
  source_amount numeric(28,8) NOT NULL CHECK (source_amount > 0),
  price         numeric(28,8) NOT NULL,
  fee_rate      numeric(7,6)  NOT NULL,
  fee_amount    numeric(28,8) NOT NULL,
  net_amount    numeric(28,8) NOT NULL,
  target_amount numeric(28,8) NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','EXPIRED','USED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);

CREATE TABLE exchanges (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            text NOT NULL REFERENCES users(id),
  quote_id           uuid NOT NULL UNIQUE REFERENCES quotes(id),
  status             text NOT NULL CHECK (status IN
                     ('CREATED','PROCESSING','PENDING_REVIEW',
                      'COMPLETED','REJECTED','FAILED')),
  risk_level         text CHECK (risk_level IN ('LOW','MEDIUM','HIGH')),
  requires_follow_up boolean NOT NULL DEFAULT false,
  source_amount      numeric(28,8) NOT NULL,
  price              numeric(28,8) NOT NULL,
  fee_amount         numeric(28,8) NOT NULL,
  target_amount      numeric(28,8) NOT NULL,
  failure_reason     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  user_id         text NOT NULL REFERENCES users(id),
  key             text NOT NULL,
  request_hash    text NOT NULL,
  exchange_id     uuid REFERENCES exchanges(id),
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE ledger_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id        uuid NOT NULL REFERENCES wallets(id),
  exchange_id      uuid NOT NULL REFERENCES exchanges(id),
  entry_type       text NOT NULL CHECK (entry_type IN
                   ('DEBIT','CREDIT','HOLD','RELEASE')),
  amount           numeric(28,8) NOT NULL CHECK (amount > 0),
  available_before numeric(28,8) NOT NULL,
  available_after  numeric(28,8) NOT NULL,
  held_before      numeric(28,8) NOT NULL,
  held_after       numeric(28,8) NOT NULL,
  status           text NOT NULL DEFAULT 'CONFIRMED',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exchange_id, wallet_id, entry_type)
);

CREATE TABLE compliance_checks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_id      uuid NOT NULL REFERENCES exchanges(id),
  provider         text NOT NULL,
  risk_level       text,
  request_payload  jsonb NOT NULL,
  response_payload jsonb,
  outcome          text NOT NULL CHECK (outcome IN ('OK','ERROR')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE compliance_decisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_id uuid NOT NULL UNIQUE REFERENCES exchanges(id),
  reviewer_id text NOT NULL REFERENCES users(id),
  decision    text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  reason      text,
  decided_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE exchange_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_id uuid NOT NULL REFERENCES exchanges(id),
  from_status text,
  to_status   text NOT NULL,
  actor_id    text,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

/* Inmutabilidad: un disparador que rechaza UPDATE y DELETE sobre
   ledger_entries, compliance_checks, compliance_decisions y
   exchange_events. */