import {
  closeDb,
  insertExchange,
  insertQuote,
  resetDb,
  testPool,
} from "../helpers";

// Caso B11: las reglas de integridad que protege la BASE DE DATOS misma (triggers y CHECK de migrations/001_schema.sql),
// con independencia de lo que haga o deje de hacer el código de la aplicación. Si alguien escribiera SQL directo (o la app
// tuviera un error), la base debe seguir rechazando lo inválido. Cada caso negativo exige el mensaje ESPECÍFICO de la regla.
describe("integridad en la base de datos", () => {
  const sql = (statement: string, params: unknown[] = []) =>
    testPool.query(statement, params);

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  // Una operación en el estado indicado, recorriendo solo transiciones VÁLIDAS para llegar a él.
  const exchangeIn = async (
    status:
      | "PROCESSING"
      | "COMPLETED"
      | "PENDING_REVIEW"
      | "REJECTED"
      | "FAILED",
  ): Promise<{ quote: string; exchange: string }> => {
    const quote = await insertQuote({ amount: "100" });
    const exchange = await insertExchange(quote);
    if (status === "COMPLETED")
      await sql(
        "UPDATE exchanges SET status = 'COMPLETED', risk_level = 'LOW' WHERE id = $1",
        [exchange],
      );
    if (status === "PENDING_REVIEW" || status === "REJECTED")
      await sql(
        "UPDATE exchanges SET status = 'PENDING_REVIEW', risk_level = 'HIGH' WHERE id = $1",
        [exchange],
      );
    if (status === "REJECTED")
      await sql("UPDATE exchanges SET status = 'REJECTED' WHERE id = $1", [
        exchange,
      ]);
    if (status === "FAILED")
      await sql(
        "UPDATE exchanges SET status = 'FAILED', failure_reason = 'X' WHERE id = $1",
        [exchange],
      );
    return { quote, exchange };
  };

  describe("tablas de solo inserción: no admiten UPDATE ni DELETE", () => {
    const insertRows = async (): Promise<void> => {
      const { exchange } = await exchangeIn("PENDING_REVIEW");
      await sql(
        "INSERT INTO exchange_events (exchange_id, to_status) VALUES ($1, 'PENDING_REVIEW')",
        [exchange],
      );
      await sql(
        "INSERT INTO compliance_checks (exchange_id, provider, outcome, risk_level, request_payload) VALUES ($1, 'MOCK', 'OK', 'HIGH', '{}')",
        [exchange],
      );
      await sql(
        "INSERT INTO compliance_decisions (exchange_id, reviewer_id, decision, reason) VALUES ($1, 'compliance-001', 'REJECTED', 'x')",
        [exchange],
      );
    };

    it.each([
      ["ledger_entries", "UPDATE ledger_entries SET amount = 2"],
      ["ledger_entries", "DELETE FROM ledger_entries"],
      ["exchange_events", "UPDATE exchange_events SET reason = 'x'"],
      ["exchange_events", "DELETE FROM exchange_events"],
      ["compliance_checks", "UPDATE compliance_checks SET provider = 'x'"],
      ["compliance_checks", "DELETE FROM compliance_checks"],
      [
        "compliance_decisions",
        "UPDATE compliance_decisions SET decision = 'APPROVED'",
      ],
      ["compliance_decisions", "DELETE FROM compliance_decisions"],
    ])("%s: %s", async (table, statement) => {
      await insertRows();
      await expect(sql(statement)).rejects.toThrow(
        new RegExp(
          `${statement.split(" ")[0]} on ${table} is not allowed: table is append-only`,
        ),
      );
    });
  });

  describe("wallets, cotizaciones y operaciones nunca se borran", () => {
    it.each(["wallets", "quotes", "exchanges"])(
      "DELETE FROM %s",
      async (table) => {
        await exchangeIn("PROCESSING");
        await expect(sql(`DELETE FROM ${table}`)).rejects.toThrow(
          new RegExp(`DELETE on ${table} is not allowed`),
        );
      },
    );
  });

  describe("cotización: el precio y los montos son inmutables (D10, R9)", () => {
    it.each([
      ["price", "2400"],
      ["fee_rate", "0.02"],
      ["fee_amount", "1.5"],
      ["net_amount", "98"], // el neto real de 100 USDT es 99: otro valor, para que haya un cambio de verdad
      ["source_amount", "200"],
      ["target_amount", "0.5"],
      ["expires_at", "now() + interval '1 day'"],
      ["created_at", "now() - interval '1 day'"],
      ["user_id", "'compliance-001'"],
      ["source_asset", "'XAUT-SBX'"],
    ])("no se puede modificar %s", async (column, value) => {
      const quote = await insertQuote({ amount: "100" });
      await expect(
        sql(`UPDATE quotes SET ${column} = ${value} WHERE id = $1`, [quote]),
      ).rejects.toThrow(/is immutable except for status/);
    });

    it("solo cambia de estado ACTIVE → USED o ACTIVE → EXPIRED", async () => {
      const toUsed = await insertQuote({ amount: "100" });
      const toExpired = await insertQuote({ amount: "100" });
      await sql("UPDATE quotes SET status = 'USED' WHERE id = $1", [toUsed]); // control positivo
      await sql("UPDATE quotes SET status = 'EXPIRED' WHERE id = $1", [
        toExpired,
      ]); // control positivo

      for (const [id, to] of [
        [toUsed, "ACTIVE"],
        [toUsed, "EXPIRED"],
        [toExpired, "ACTIVE"],
        [toExpired, "USED"],
      ]) {
        await expect(
          sql(`UPDATE quotes SET status = '${to}' WHERE id = $1`, [id]),
        ).rejects.toThrow(/invalid quote transition/);
      }
    });
  });

  describe("operación: máquina de estados (D3)", () => {
    it("permite las transiciones válidas (control positivo)", async () => {
      await exchangeIn("COMPLETED");
      await exchangeIn("PENDING_REVIEW");
      await exchangeIn("REJECTED");
      await exchangeIn("FAILED");
      const { exchange } = await exchangeIn("PENDING_REVIEW");
      await sql("UPDATE exchanges SET status = 'COMPLETED' WHERE id = $1", [
        exchange,
      ]); // PENDING_REVIEW → COMPLETED
    });

    it.each([
      ["COMPLETED", "FAILED"],
      ["COMPLETED", "PENDING_REVIEW"],
      ["REJECTED", "COMPLETED"],
      ["FAILED", "PROCESSING"],
      ["FAILED", "COMPLETED"],
      ["PROCESSING", "REJECTED"],
      ["PENDING_REVIEW", "FAILED"],
      ["PENDING_REVIEW", "PROCESSING"],
    ] as const)("%s → %s es inválida", async (from, to) => {
      const { exchange } = await exchangeIn(from);
      const extra =
        to === "FAILED"
          ? ", failure_reason = 'X'"
          : to === "PENDING_REVIEW"
            ? ", risk_level = 'HIGH'"
            : "";
      await expect(
        sql(`UPDATE exchanges SET status = '${to}'${extra} WHERE id = $1`, [
          exchange,
        ]),
      ).rejects.toThrow(/invalid exchange transition/);
    });

    it("una operación solo puede nacer en PROCESSING", async () => {
      const quote = await insertQuote({ amount: "100" });
      await expect(
        sql(
          "INSERT INTO exchanges (user_id, quote_id, idempotency_key, status, risk_level) VALUES ('user-001', $1, 'k', 'COMPLETED', 'LOW')",
          [quote],
        ),
      ).rejects.toThrow(/must be created in PROCESSING/);
    });

    it.each([
      ["user_id", "'compliance-001'"],
      ["idempotency_key", "'otra'"],
      ["created_at", "now() - interval '1 day'"],
    ])("su identidad es inmutable: %s", async (column, value) => {
      const { exchange } = await exchangeIn("PROCESSING");
      await expect(
        sql(`UPDATE exchanges SET ${column} = ${value} WHERE id = $1`, [
          exchange,
        ]),
      ).rejects.toThrow(/identity columns are immutable/);
    });

    it("el seguimiento solo existe en una MEDIUM completada, y el motivo de fallo solo en FAILED", async () => {
      const a = await exchangeIn("PROCESSING");
      await expect(
        sql(
          "UPDATE exchanges SET status = 'COMPLETED', risk_level = 'LOW', requires_follow_up = true WHERE id = $1",
          [a.exchange],
        ),
      ).rejects.toThrow(/violates check constraint/);
      await expect(
        sql("UPDATE exchanges SET status = 'FAILED' WHERE id = $1", [
          a.exchange,
        ]),
      ).rejects.toThrow(/violates check constraint/); // FAILED sin motivo
      await expect(
        sql("UPDATE exchanges SET status = 'COMPLETED' WHERE id = $1", [
          a.exchange,
        ]),
      ).rejects.toThrow(/violates check constraint/); // COMPLETED sin riesgo
    });

    it("una cotización no puede tener dos operaciones vivas, pero sí una viva y otras FAILED (D8)", async () => {
      const { quote, exchange } = await exchangeIn("PROCESSING");
      await expect(insertExchange(quote, { key: "otra" })).rejects.toThrow(
        /exchanges_quote_live_uq/,
      );
      await sql(
        "UPDATE exchanges SET status = 'FAILED', failure_reason = 'X' WHERE id = $1",
        [exchange],
      );
      await insertExchange(quote, { key: "reintento" }); // ahora sí
    });

    it("la operación y la cotización deben ser del mismo usuario", async () => {
      const quote = await insertQuote({ amount: "100" });
      await expect(
        insertExchange(quote, { userId: "compliance-001" }),
      ).rejects.toThrow(/foreign key/);
    });
  });

  describe("saldos", () => {
    it.each([
      ["available", "wallets_available_check"],
      ["held", "wallets_held_check"],
    ])("%s nunca es negativo", async (column, constraint) => {
      await expect(
        sql(
          `UPDATE wallets SET ${column} = -1 WHERE user_id = 'user-001' AND asset_code = 'USDT-SBX'`,
        ),
      ).rejects.toThrow(new RegExp(constraint));
    });

    it("una wallet nueva no puede nacer con saldo: el saldo entra solo como movimiento (D2)", async () => {
      await sql(
        "INSERT INTO users (id, role, name) VALUES ('user-009', 'USER', 'Nuevo')",
      );
      await expect(
        sql(
          "INSERT INTO wallets (user_id, asset_code, available) VALUES ('user-009', 'USDT-SBX', 5)",
        ),
      ).rejects.toThrow(/zero balance/);
      await sql(
        "INSERT INTO wallets (user_id, asset_code) VALUES ('user-009', 'USDT-SBX')",
      ); // en cero, sí
    });

    it("un movimiento no puede dejar el saldo anterior/posterior incoherente", async () => {
      const { exchange } = await exchangeIn("PROCESSING");
      const wallet = (
        await sql(
          "SELECT id FROM wallets WHERE user_id = 'user-001' AND asset_code = 'USDT-SBX'",
        )
      ).rows[0].id;
      await expect(
        sql(
          "INSERT INTO ledger_entries (wallet_id, reference_type, exchange_id, entry_type, balance_type, amount, balance_before, balance_after) VALUES ($1, 'EXCHANGE', $2, 'DEBIT', 'AVAILABLE', 10, 100, 95)",
          [wallet, exchange],
        ),
      ).rejects.toThrow(/violates check constraint/);
    });
  });

  describe("decisiones de Cumplimiento", () => {
    it("solo un usuario con rol COMPLIANCE puede ser revisor (clave foránea compuesta)", async () => {
      const { exchange } = await exchangeIn("PENDING_REVIEW");
      await expect(
        sql(
          "INSERT INTO compliance_decisions (exchange_id, reviewer_id, decision) VALUES ($1, 'user-001', 'APPROVED')",
          [exchange],
        ),
      ).rejects.toThrow(/foreign key/);
    });

    it("rechazar exige un motivo no vacío, y solo hay una decisión por operación", async () => {
      const { exchange } = await exchangeIn("PENDING_REVIEW");
      await expect(
        sql(
          "INSERT INTO compliance_decisions (exchange_id, reviewer_id, decision, reason) VALUES ($1, 'compliance-001', 'REJECTED', '   ')",
          [exchange],
        ),
      ).rejects.toThrow(/violates check constraint/);
      await sql(
        "INSERT INTO compliance_decisions (exchange_id, reviewer_id, decision) VALUES ($1, 'compliance-001', 'APPROVED')",
        [exchange],
      );
      await expect(
        sql(
          "INSERT INTO compliance_decisions (exchange_id, reviewer_id, decision) VALUES ($1, 'compliance-001', 'APPROVED')",
          [exchange],
        ),
      ).rejects.toThrow(/compliance_decisions_exchange_id_key/);
    });
  });
});
