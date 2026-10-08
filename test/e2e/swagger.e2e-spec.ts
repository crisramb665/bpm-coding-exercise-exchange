import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { calculateQuote, formatAmount } from "../../src/common/money/money";
import { setupSwagger } from "../../src/common/swagger/setup-swagger";
import {
  EXCHANGE_DETAIL_EXAMPLE,
  EXCHANGE_SUMMARY_EXAMPLE,
  MOVEMENTS_EXAMPLE,
  PENDING_EXAMPLE,
  QUOTE_EXAMPLE,
  WALLETS_EXAMPLE,
} from "../../src/common/swagger/examples";
import { closeDb, createApp, resetDb } from "../helpers";

// Grupo (etiqueta) de cada ruta en Swagger UI.
function expectedTag(route: string): string {
  if (route.includes("/compliance/")) return "Cumplimiento (revisión humana)";
  if (route.includes(" /wallets")) return "Wallets";
  if (route.includes(" /quotes")) return "Cotizaciones";
  return "Intercambios";
}

type Operation = {
  summary?: string;
  tags?: string[];
  security?: Record<string, string[]>[];
  parameters?: { name: string; in: string; required?: boolean }[];
  responses: Record<string, unknown>;
  requestBody?: { content: Record<string, { schema: { $ref?: string } }> };
};

// Las 9 rutas del enunciado (sección 4 y spec §5): ni una más, ni una menos.
const EXPECTED_ROUTES = [
  "GET /wallets",
  "GET /wallets/{id}/movements",
  "POST /quotes",
  "POST /exchanges",
  "GET /exchanges",
  "GET /exchanges/{id}",
  "GET /compliance/exchanges/pending",
  "PATCH /compliance/exchanges/{id}/approve",
  "PATCH /compliance/exchanges/{id}/reject",
];

// Las claves que tiene un valor, recursivamente (en los arreglos, las del primer elemento). Sirve para comprobar que un
// ejemplo de la documentación tiene la MISMA FORMA que una respuesta real, sin depender de ids ni fechas.
function shape(value: unknown, path = ""): string[] {
  if (Array.isArray(value))
    return value.length ? shape(value[0], `${path}[]`) : [`${path}[]`];
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [
      `${path}.${k}`,
      ...shape(v, `${path}.${k}`),
    ]);
  }
  return [];
}

describe("documentación Swagger (/docs)", () => {
  let app: INestApplication;
  let doc: {
    paths: Record<string, Record<string, Operation>>;
    components: {
      schemas: Record<string, any>;
      securitySchemes: Record<string, any>;
    };
  };

  const operations = (): [string, Operation][] =>
    Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(
        ([method, op]) =>
          [`${method.toUpperCase()} ${path}`, op] as [string, Operation],
      ),
    );
  const op = (route: string): Operation =>
    operations().find(([r]) => r === route)![1];

  beforeAll(async () => {
    app = await createApp({ beforeInit: setupSwagger });
    doc = (await request(app.getHttpServer()).get("/docs-json").expect(200))
      .body;
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it("/docs (la interfaz) y /docs-json (el documento) se abren sin X-User-Id", async () => {
    const ui = await request(app.getHttpServer()).get("/docs").expect(200);
    expect(ui.headers["content-type"]).toMatch(/text\/html/);
    expect(ui.text).toContain("swagger");
    expect(
      (await request(app.getHttpServer()).get("/docs-json")).headers[
        "content-type"
      ],
    ).toMatch(/json/);
  });

  it("documenta EXACTAMENTE las 9 rutas de la API", () => {
    expect(
      operations()
        .map(([route]) => route)
        .sort(),
    ).toEqual([...EXPECTED_ROUTES].sort());
  });

  it("cada ruta tiene resumen, etiqueta, el usuario como requisito de seguridad y el 401 documentado", () => {
    for (const [route, operation] of operations()) {
      expect({ route, summary: Boolean(operation.summary) }).toEqual({
        route,
        summary: true,
      });
      // Las etiquetas agrupan las rutas en la interfaz. @nestjs/swagger etiqueta SOLO con el nombre de la clase si falta @ApiTags
      // (autoTagControllers), así que se exige el nombre en español de cada grupo, no "alguna" etiqueta.
      expect({ route, tags: operation.tags }).toEqual({
        route,
        tags: [expectedTag(route)],
      });
      expect({ route, security: operation.security }).toEqual({
        route,
        security: [{ "X-User-Id": [] }],
      });
      expect({ route, tiene401: "401" in operation.responses }).toEqual({
        route,
        tiene401: true,
      });
    }
  });

  it("X-User-Id es un esquema de seguridad apiKey en el encabezado", () => {
    expect(doc.components.securitySchemes["X-User-Id"]).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "X-User-Id",
    });
  });

  describe("POST /exchanges", () => {
    it("exige el encabezado Idempotency-Key", () => {
      expect(op("POST /exchanges").parameters).toContainEqual(
        expect.objectContaining({
          name: "Idempotency-Key",
          in: "header",
          required: true,
        }),
      );
    });

    it("documenta todos sus resultados: 201 y los errores 400, 401, 403, 404, 409, 422 y 503", () => {
      expect(Object.keys(op("POST /exchanges").responses).sort()).toEqual([
        "201",
        "400",
        "401",
        "403",
        "404",
        "409",
        "422",
        "503",
      ]);
    });

    it("los códigos de negocio de cada error aparecen en la descripción", () => {
      const responses = op("POST /exchanges").responses as Record<
        string,
        { description: string }
      >;
      expect(responses["409"].description).toEqual(
        expect.stringContaining("IDEMPOTENCY_KEY_MISMATCH"),
      );
      expect(responses["409"].description).toEqual(
        expect.stringContaining("QUOTE_ALREADY_USED"),
      );
      expect(responses["422"].description).toEqual(
        expect.stringContaining("INSUFFICIENT_FUNDS"),
      );
      expect(responses["503"].description).toEqual(
        expect.stringContaining("COMPLIANCE_UNAVAILABLE"),
      );
    });
  });

  it("los errores se describen con la forma única { error: { code, message, details? } }", () => {
    const schema = doc.components.schemas;
    expect(schema.ErrorResponse.required).toEqual(["error"]);
    expect(Object.keys(schema.ErrorBody.properties).sort()).toEqual([
      "code",
      "details",
      "message",
    ]);
    expect(schema.ErrorBody.required).toEqual(["code", "message"]); // details es opcional
  });

  describe("cuerpos de las peticiones", () => {
    it("POST /quotes: source_amount es un string con patrón, no un número", () => {
      const schema = doc.components.schemas.CreateQuoteDto;
      expect(schema.required.sort()).toEqual([
        "source_amount",
        "source_asset",
        "target_asset",
      ]);
      expect(schema.properties.source_amount).toMatchObject({
        type: "string",
        pattern: "^\\d{1,20}(\\.\\d{1,8})?$",
      });
      expect(schema.properties.source_asset.example).toBe("USDT-SBX");
      expect(schema.properties.target_asset.example).toBe("XAUT-SBX");
    });

    it("POST /exchanges: solo quote_id (uuid)", () => {
      const schema = doc.components.schemas.CreateExchangeDto;
      expect(schema.required).toEqual(["quote_id"]);
      expect(schema.properties.quote_id).toMatchObject({
        type: "string",
        format: "uuid",
      });
    });

    it("rechazar exige el motivo y aprobar no", () => {
      expect(doc.components.schemas.RejectDto.required).toEqual(["reason"]);
      expect(doc.components.schemas.ApproveDto.required).toBeUndefined();
    });
  });

  // Una documentación con ejemplos que no se parecen a la realidad es peor que ninguna. Se comparan con respuestas reales.
  describe("los ejemplos de la documentación reflejan las respuestas reales", () => {
    const user = (path: string, id = "user-001") =>
      request(app.getHttpServer()).get(path).set("X-User-Id", id);

    it("el ejemplo de cotización cumple las reglas de cálculo y tiene la misma forma que POST /quotes", async () => {
      const real = await request(app.getHttpServer())
        .post("/quotes")
        .set("X-User-Id", "user-001")
        .send({
          source_asset: "USDT-SBX",
          target_asset: "XAUT-SBX",
          source_amount: "2500",
        })
        .expect(201);
      expect(shape(QUOTE_EXAMPLE).sort()).toEqual(shape(real.body).sort());

      // Los números del ejemplo son los que realmente calcula el sistema (no valores inventados).
      const q = calculateQuote(QUOTE_EXAMPLE.source_amount);
      expect({
        fee: QUOTE_EXAMPLE.fee_amount,
        net: QUOTE_EXAMPLE.net_amount,
        target: QUOTE_EXAMPLE.target_amount,
      }).toEqual({
        fee: formatAmount(q.feeAmount),
        net: formatAmount(q.netAmount),
        target: formatAmount(q.targetAmount),
      });
    });

    it("los ejemplos de wallets, movimientos, operación y listado tienen la misma forma que las respuestas reales", async () => {
      const quote = await request(app.getHttpServer())
        .post("/quotes")
        .set("X-User-Id", "user-001")
        .send({
          source_asset: "USDT-SBX",
          target_asset: "XAUT-SBX",
          source_amount: "2500",
        })
        .expect(201);
      const exchange = await request(app.getHttpServer())
        .post("/exchanges")
        .set("X-User-Id", "user-001")
        .set("Idempotency-Key", "doc-1")
        .send({ quote_id: quote.body.id })
        .expect(201);

      const wallets = (await user("/wallets").expect(200)).body;
      const usdt = wallets.find(
        (w: { asset: string }) => w.asset === "USDT-SBX",
      );
      const movements = (
        await user(`/wallets/${usdt.id}/movements`).expect(200)
      ).body;
      const list = (await user("/exchanges").expect(200)).body;

      expect(shape(WALLETS_EXAMPLE).sort()).toEqual(shape(wallets).sort());
      expect(shape(MOVEMENTS_EXAMPLE).sort()).toEqual(shape(movements).sort());
      expect(shape(EXCHANGE_SUMMARY_EXAMPLE).sort()).toEqual(
        shape(list).sort(),
      );
      expect(shape(EXCHANGE_DETAIL_EXAMPLE).sort()).toEqual(
        shape(exchange.body).sort(),
      );
    });

    it("el ejemplo de la bandeja de Cumplimiento tiene la misma forma que la respuesta real", async () => {
      const quote = await request(app.getHttpServer())
        .post("/quotes")
        .set("X-User-Id", "user-001")
        .send({
          source_asset: "USDT-SBX",
          target_asset: "XAUT-SBX",
          source_amount: "5000.01",
        })
        .expect(201);
      await request(app.getHttpServer())
        .post("/exchanges")
        .set("X-User-Id", "user-001")
        .set("Idempotency-Key", "doc-2")
        .send({ quote_id: quote.body.id })
        .expect(201);

      const pending = (
        await user("/compliance/exchanges/pending", "compliance-001").expect(
          200,
        )
      ).body;

      expect(pending).toHaveLength(1);
      expect(shape(PENDING_EXAMPLE).sort()).toEqual(shape(pending).sort());
    });
  });
});
