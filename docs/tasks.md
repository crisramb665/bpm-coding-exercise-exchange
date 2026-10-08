# Tareas

Las tareas son pequeñas y van en orden; cada una termina con su criterio de terminado (DoD) cumplido y con las pruebas
en verde. Las referencias apuntan a `docs/spec.md` (R, D, S) y a `docs/plan.md` (§).

- **Día 1 (~7 h 50 min + 30 min opcionales):** implementación y pruebas.
- **Día 2 (~6 h 50 min, margen incluido):** README, diagrama, mockup y revisión.

Al cerrar cada tarea se hace un commit pequeño.

---

## Día 1: implementación

| # | Tarea | DoD | Est. |
|---|---|---|---|
| T01 | **Proyecto base.** `nest new` con pnpm; `tsconfig` estricto; `.nvmrc` (22); `.env.example`; `.gitignore`. Se eliminan el controller y el service de ejemplo. | `pnpm run build` compila sin errores; `strict: true`. | 25 min |
| T02 | **Docker y scripts.** `docker-compose.yml` (postgres:16 en el puerto 5433, healthcheck) y los scripts `db:up`, `migrate`, `start`, `up`, `test` (plan §2). | `pnpm run db:up` deja la base healthy. | 15 min |
| T03 | **Migraciones.** `scripts/migrate.ts`; `002_seed.sql` (semilla con el depósito inicial como movimiento, D2); borrar `docs/schema.sql` (D16). | `pnpm run up` aplica 001 y 002 una sola vez (volver a ejecutarlo no hace nada); `SELECT` muestra 10.000 USDT en user-001 y un movimiento INITIAL_DEPOSIT. | 30 min |
| T04 | **Infraestructura de pruebas.** `globalSetup` (recrea `exchange_test` y migra), `test/helpers.ts` (`createApp`, `resetDb`) y una prueba de humo. | `pnpm test` corre desde cero con la base apagada y pasa en verde. | 35 min |
| T05 | **Common.** `PG_POOL` + `withTransaction`; `BusinessError` + filtro; `AuthGuard` (401) + `@Roles` / `RolesGuard` (403); `ValidationPipe` global. | Pruebas B5: 401 sin encabezado o con usuario inexistente; 403 por rol. | 40 min |
| T06 | **Dinero.** `calculateQuote` con decimal.js (D5). *(`riskLevelFor` se movió al mock de cumplimiento en la T09, D19.)* | Prueba B1: toda la tabla de la spec §7 coincide exactamente (como strings). | 25 min |
| T07 | **Wallets.** `GET /wallets` y `GET /wallets/:id/movements` (con limit y orden por id). | e2e: user-001 ve 10.000 / 0 / 10.000 y su movimiento inicial; wallet ajena → 404 (B8). | 25 min |
| T08 | **Cotizaciones.** `POST /quotes` con DTO (monto como string, regex, par soportado), AMOUNT_TOO_SMALL y `expires_at` calculado con la hora de la base. | e2e B2, B3; respuesta 201 con los campos de la spec §5.3; COMPLIANCE → 403. | 35 min |
| T09 | **Servicio de cumplimiento** (en `src/compliance-service/`). Interfaz, token, `MockComplianceProvider` (umbrales R10), `ComplianceClient` con timeout y duración, `COMPLIANCE_MOCK_FAIL`. | Prueba unitaria: 999,99 → LOW, 1.000 y 5.000 → MEDIUM, 5.000,01 → HIGH; un provider lento → ERROR por timeout. | 15 min |
| T10 | **Ledger.** `LedgerRepository.applyMovement` y `lockWallets` (plan §3) y el helper de prueba `assertReconciled`. | Es la única función que hace UPDATE sobre `wallets` (verificable con grep); los CHECKs de la base no se disparan en el flujo normal. | 25 min |
| T11 | **POST /exchanges, Tx1.** Reserva de la clave, reproducción de respuestas, mismatch e in-progress; bloqueo de la cotización; QUOTE_NOT_FOUND / IN_USE / ALREADY_USED / EXPIRED; saldo preliminar; INSERT en PROCESSING + evento (plan §5). | e2e c, d, f, B7; respuestas guardadas o liberadas según la tabla D11. | 50 min |
| T12 | **POST /exchanges, consulta y Tx2.** Los activos del débito y del crédito salen de la cotización, no de constantes (D18). Llamada a cumplimiento fuera de transacción; bloqueos en orden; LOW/MEDIUM/HIGH/ERROR/saldo insuficiente; check, eventos, cotización USED; respuesta 201/422/503. | e2e a, b, e, g, B4, B6, con `assertReconciled` al final de cada una. | 60 min |
| T13 | **Consultas.** `GET /exchanges` (`?userId` con D6 y D13) y `GET /exchanges/:id` (detalle + trazabilidad, spec §5.6). | e2e: un USER ve solo lo suyo; un `userId` ajeno → 403; COMPLIANCE filtra; el detalle incluye cotización, movimientos, checks, decisión y eventos; exchange ajeno → 404. | 25 min |
| T14 | **Cumplimiento: bandeja y decisiones** (en `src/compliance-review/`, módulo nuevo y separado del servicio automático). `GET /compliance/exchanges/pending`, approve, reject (plan §6). | e2e h, i, j, B9; `compliance_decisions` + evento con actor; conciliación correcta; tras aprobar y tras rechazar, las wallets de `compliance-001` siguen en 0 y sin movimientos de ledger (D17). | 45 min |
| T15 | **Swagger y prueba manual.** *(La guía de pruebas manuales ya existe y está verificada contra el servidor real: `docs/pruebas_manuales.md`; esta tarea la reutiliza y de ahí salen los curl del README, T19.)* `@nestjs/swagger` en `/docs` (DTOs + encabezados `X-User-Id` / `Idempotency-Key`); recorrido con curl del flujo completo sobre `pnpm run up`. | `/docs` muestra los 9 endpoints; los curl que irán al README funcionan copiados y pegados. | 20 min |
| T16 *(opcional)* | **Pruebas de concurrencia e inmutabilidad.** *(Revisada: B12, B13 y B14 ya estaban cubiertas desde las T11, T12 y T14; solo faltaba B11, que se hizo en `integrity.e2e-spec.ts`.)* B11 (obligatoria si hay tiempo, 5 min), B12, B13, B14. | Las pruebas pasan 5 veces seguidas sin fallos intermitentes. | 30 min |

**Punto de control del día 1:** `pnpm install && pnpm test` desde un clon limpio, con los escenarios a–j en verde.

## Día 2: documentación, diagrama, mockup y revisión

| # | Tarea | DoD | Est. |
|---|---|---|---|
| T17 | **Diagrama.** *(Hecha: `diagram.mmd` es la arquitectura que pide 9.3; `diagram-exchange-flow.mmd` el flujo de las dos transacciones; `diagram-er.mmd` el modelo de datos. Las imágenes están en `docs/img/`.)* `docs/diagram.mmd` en Mermaid: usuario, rol de Cumplimiento, API, servicio de cotización, servicio de cumplimiento simulado, base de datos, wallets y ledger (enunciado 9.3), con el flujo de las dos transacciones. Opcional: un ER `erDiagram` desde 001. | Se renderiza en GitHub o en mermaid.live; contiene todos los elementos que pide 9.3. | 30 min |
| T18 | **Mockup.** 4 pantallas de baja fidelidad (Excalidraw o Penpot): panel del usuario, solicitud de intercambio (con vigencia y validaciones), resultado (completada, pendiente, rechazada, vencida, saldo insuficiente) y bandeja de Cumplimiento. Se exporta a PDF o PNG en `docs/mockup/`. | Cada estado y cada código de error de la spec §5.4 que ve el usuario tiene su representación; los nombres de estado coinciden con el backend. | 90 min |
| T19 | **README, secciones 1–12** (plan §10): comandos, usuarios, curl, arquitectura, decisiones, concurrencia, supuestos, limitaciones, producción, partida doble. | Una persona sin contexto lo ejecuta en 3 comandos; todo lo que pide 9.2 está presente. | 90 min |
| T20 | **README, sección 13: respuestas a–f** de la sección 10 del enunciado. | Seis respuestas breves (5–10 líneas cada una), concretas y coherentes con el diseño actual. | 60 min |
| T21 | **Revisión para la sustentación.** Leer todo el código de punta a punta; comentar el porqué donde falte; ensayar la explicación del flujo de dos transacciones y del orden de bloqueos; `/code-review`. | El autor puede explicar cada archivo sin mirar notas; no quedan TODO ni código muerto. | 60 min |
| T22 | **Verificación final.** Clonar en una carpeta nueva y ejecutar `pnpm install`, `pnpm run up` y `pnpm test`; revisar los enlaces del README. | Los 3 comandos funcionan desde cero; las pruebas pasan en verde. | 20 min |
| T23 | **Cierre del registro.** Completar `docs/ia_y_tiempo.md` y la sección 15 del README (herramientas de IA y tiempo total). | Están todas las fases con su tiempo; la declaración de IA cumple la sección 11 del enunciado. | 15 min |
| — | Margen | Imprevistos. | 45 min |

## Dependencias

```
T01 → T02 → T03 → T04 → T05 ─┬─► T07
                  T06 ───────┼─► T08
                  T09 ───────┤
                  T10 ───────┴─► T11 → T12 → T13 → T14 → T15 → (T16)
Día 2: T17, T18 en paralelo con T19 → T20 → T21 → T22 → T23
```
