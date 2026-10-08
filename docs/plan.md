# Plan técnico

Implementa `docs/spec.md`. El esquema está en `migrations/001_schema.sql`, que es la fuente de verdad y ya se validó
contra postgres:16: compila, los flujos válidos pasan, 26 casos inválidos se rechazan, la conciliación entre ledger y
saldo cuadra y TRUNCATE funciona para limpiar en las pruebas.

---

## 1. Stack y dependencias

| Uso | Paquete | Por qué |
| --- | --- | --- |
| Framework | `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express` | Los guards resuelven 401/403 de forma declarativa y la inyección de dependencias permite cambiar el servicio de cumplimiento en las pruebas. |
| Base de datos | `pg` | SQL directo, sin ORM (regla 2). |
| Dinero | `decimal.js` | Aritmética decimal exacta y redondeos explícitos (regla 3). |
| Validación | `class-validator`, `class-transformer` | El `ValidationPipe` estándar de Nest; los DTOs quedan legibles. |
| Documentación de la API | `@nestjs/swagger` | Swagger UI en `/docs` como "colección de API o documentación equivalente". |
| Pruebas | `jest`, `ts-jest`, `supertest`, `@nestjs/testing` | Son el estándar de Nest y prueban la API HTTP contra la base real. |
| Scripts | `tsx` | Ejecuta `scripts/migrate.ts` sin compilar antes. |

Se usa Node 22 (con `.nvmrc`) y pnpm.

Versiones fijadas a propósito: **NestJS 11** (el 12 se publica solo como ESM y Jest 30 no puede cargarlo en Node 22) y
**TypeScript 6** (el CLI de Nest aún no soporta TypeScript 7).

Configuración por variables de entorno, con valores por defecto en `.env.example`:

| Variable | Valor por defecto |
| --- | --- |
| `DATABASE_URL` | `postgres://exchange:exchange@localhost:5433/exchange` |
| `PORT` | 3000 |
| `QUOTE_TTL_SECONDS` | 30 |
| `COMPLIANCE_TIMEOUT_MS` | 2000 |
| `COMPLIANCE_MOCK_FAIL` | false |

El puerto 5433 evita chocar con un Postgres local instalado en el 5432.

## 2. Infraestructura y comandos (D15)

- **`docker-compose.yml`:** un solo servicio `db` (postgres:16) con healthcheck `pg_isready` y un volumen nombrado.
  La API corre en el host, para no tener que construir una imagen.
- **Scripts de `package.json`:**

  ```
  "db:up":   "docker compose up -d --wait db"
  "migrate": "tsx scripts/migrate.ts"
  "start":   "nest start"
  "up":      "pnpm run db:up && pnpm run migrate && pnpm run start"
  "test":    "pnpm run db:up && jest --runInBand"
  ```

  `--runInBand` corre las pruebas en serie porque comparten la base `exchange_test`.
- **`scripts/migrate.ts` (unas 40 líneas):**
  1. Crea `schema_migrations(filename text PK, applied_at timestamptz)` si no existe.
  2. Lee `migrations/*.sql` en orden alfabético.
  3. Para cada archivo pendiente, en una transacción: ejecuta el SQL e inserta el nombre del archivo.
  4. Acepta la URL de la base como argumento, para poder reutilizarlo con la base de pruebas.
- **Migraciones:**
  - `001_schema.sql`: el esquema completo.
  - `002_seed.sql`: assets, user-001 y compliance-001, cuatro wallets en cero y el depósito inicial de 10.000 USDT
    como un `UPDATE … RETURNING` seguido del INSERT del movimiento (patrón D2). Se aplica una sola vez porque queda
    registrado en `schema_migrations`.
- **Base de pruebas:** el `globalSetup` de Jest se conecta a la base `postgres`, ejecuta
  `DROP DATABASE IF EXISTS exchange_test WITH (FORCE)` y `CREATE DATABASE exchange_test`, y aplica las migraciones con
  el mismo `migrate.ts`. Antes de cada prueba se hace `TRUNCATE … RESTART IDENTITY CASCADE` y se vuelve a ejecutar el
  contenido de `002_seed.sql`. Las pruebas nunca tocan los datos de desarrollo.

## 3. Módulos y capas

```
HTTP ─► Controller (DTO + ValidationPipe, guards)
          └─► Service (reglas de negocio, transacciones, orden de bloqueos)
                └─► Repository (SQL parametrizado; recibe el PoolClient de la transacción)
```

| Módulo | Contenido |
| --- | --- |
| `common/db` | Provider `PG_POOL` (`new Pool`) y la función `withTransaction(pool, fn)`, que hace BEGIN, ejecuta `fn(client)`, y luego COMMIT, o ROLLBACK si hay error; siempre libera el cliente. Sin magia: unas 20 líneas. |
| `common/auth` | `AuthGuard` global: lee `X-User-Id`, carga el usuario y lo deja en `req.user`; si no lo encuentra, 401. `@Roles('USER')` (`SetMetadata`) + `RolesGuard`, que responde 403. |
| `common/errors` | `BusinessError(code, httpStatus, message, details?)` y un `ExceptionFilter` que lo serializa al formato de la spec (sección 5). Traduce la violación `23505` del índice `exchanges_quote_live_uq` a 409 `QUOTE_IN_USE`, como respaldo. |
| `common/money` | `calculateQuote(sourceAmount: Decimal)` → `{ feeAmount, netAmount, targetAmount }` y `riskLevelFor(amount)`. Funciones puras con `Decimal.set({ precision: 40 })` y `ROUND_UP` / `ROUND_DOWN` explícitos. |
| `wallets` | Controller y repository de lectura. También `LedgerRepository.applyMovement(client, { walletId, entryType, balanceType, amount, referenceType, exchangeId })`: **es la única función del código que modifica `wallets`**. |
| `quotes` | `POST /quotes`. |
| `compliance` | La interfaz `ComplianceProvider { assess(req): Promise<{ riskLevel }> }` y el token `COMPLIANCE_PROVIDER`. `MockComplianceProvider` implementa los umbrales de R10. `ComplianceClient` envuelve al provider con el timeout (`Promise.race`) y mide la duración. Los endpoints `/compliance/*` y `ComplianceReviewService` (aprobar y rechazar) también viven aquí. |
| `exchanges` | `ExchangesService` (crear, listar, detalle), `IdempotencyRepository` y `ExchangesRepository`. |

### `applyMovement`: el corazón del ledger

```sql
-- 1) Mover el saldo y obtener el valor nuevo (la fila ya está bloqueada con FOR UPDATE)
UPDATE wallets SET available = available ± $amount, updated_at = now()   -- o held, según balance_type
 WHERE id = $walletId RETURNING available;
-- 2) Registrar el movimiento con before = after ∓ amount
INSERT INTO ledger_entries (...) VALUES (...);
```

Si el UPDATE dejara el saldo negativo, `CHECK (available >= 0)` aborta la transacción completa: es la última defensa
contra el doble gasto. El CHECK aritmético del ledger garantiza que before y after cuadran.

## 4. Flujo de `POST /quotes`

1. Los guards verifican que haya usuario (401) y que su rol sea USER (403).
2. El DTO valida: `source_amount` es un string que cumple `^\d{1,20}(\.\d{1,8})?$`, mayor que 0, y el par es el soportado
   (400).
3. `calculateQuote`. Si `targetAmount = 0`, responde 422 `AMOUNT_TOO_SMALL`.
4. Un solo `INSERT … RETURNING` con `expires_at = now() + make_interval(secs => $ttl)`, usando la hora de la base (S6).
   Los CHECKs vuelven a verificar el cálculo.
5.   1.

## 5. Flujo de `POST /exchanges` (D8, D9, D11)

Antes de la primera transacción: guards (401/403), DTO (`quote_id` es un uuid) y encabezado `Idempotency-Key`
obligatorio, de 1 a 255 caracteres (400). Se calcula `requestHash = sha256(JSON canónico de { quote_id })`.

### Tx1: reservar (corta y sin I/O externo)

| # | Paso | Bloqueo | Si falla |
| --- | --- | --- | --- |
| 1 | `INSERT INTO idempotency_keys (user_id, key, request_hash) … ON CONFLICT DO NOTHING RETURNING` | Entrada del índice PK. Una petición concurrente con la misma clave **espera** aquí hasta el commit o rollback de esta. | Si no inserta nada: `SELECT` de la fila → si el hash es distinto, 409 `IDEMPOTENCY_KEY_MISMATCH`; si `response_status` es NULL, 409 `IDEMPOTENCY_IN_PROGRESS`; si no, se reproduce la respuesta guardada (con `Idempotent-Replayed: true`). |
| 2 | `SELECT … FROM quotes WHERE id = $1 AND user_id = $2 FOR UPDATE` | **Fila de la cotización**: serializa todas las Tx1 sobre la misma cotización. | Si no existe: 404 `QUOTE_NOT_FOUND` (se guarda y se hace COMMIT). |
| 3 | ¿Existe un exchange vivo (`status <> 'FAILED'`) para la cotización? | — | Si su estado es PROCESSING: 409 `QUOTE_IN_USE` (ROLLBACK, la clave se libera). Si la cotización está en USED: 409 `QUOTE_ALREADY_USED` (se guarda). Este paso va **antes** de comprobar el vencimiento, para que una petición concurrente no marque EXPIRED una cotización que otra operación ya tomó. |
| 4 | ¿`status = 'ACTIVE'` y `now() < expires_at`? | — | Si está vencida: `UPDATE status = 'EXPIRED'`, 422 `QUOTE_EXPIRED` (se guarda y se hace COMMIT). |
| 5 | Saldo preliminar: `available >= source_amount` (lectura **sin** bloqueo) | — | 422 `INSUFFICIENT_FUNDS` (ROLLBACK, la clave se libera). Es solo para fallar rápido; la validación definitiva está en Tx2. |
| 6 | `INSERT exchanges (status = 'PROCESSING', idempotency_key)` + evento `null → PROCESSING` + `UPDATE idempotency_keys SET exchange_id` | El índice parcial `exchanges_quote_live_uq` es el respaldo del paso 3. | La violación `23505` se traduce a 409 `QUOTE_IN_USE`. |
| 7 | COMMIT | Libera la cotización. | |

Para "guardar" una respuesta se ejecuta `UPDATE idempotency_keys SET response_status, response_body` dentro de la
misma transacción antes del COMMIT. Para "liberar" la clave en Tx1 basta con hacer ROLLBACK: la fila nunca llega a
existir.

### Fuera de transacción: consultar a cumplimiento

`ComplianceClient.assess({ exchangeId, userId, sourceAsset, sourceAmount })`, con timeout. **No hay ningún bloqueo
tomado.** El resultado es `{ outcome: 'OK', riskLevel }` o `{ outcome: 'ERROR', errorMessage }`, junto con la duración
medida.

### Tx2: aplicar

| # | Paso | Bloqueo |
| --- | --- | --- |
| 1 | `SELECT … FROM exchanges WHERE id = $1 FOR UPDATE`. Si ya no está en PROCESSING (la recuperación de D9 la marcó FAILED), se aborta sin tocar nada. | Fila del exchange |
| 2 | `SELECT … FROM quotes WHERE id = $1 FOR UPDATE` | Fila de la cotización |
| 3 | `SELECT … FROM wallets WHERE user_id = $1 AND asset_code IN (…) ORDER BY id FOR UPDATE` | **Wallets en orden fijo por `id`**, para evitar interbloqueos. |
| 4 | `INSERT compliance_checks` con el resultado (OK o ERROR) | — |
| 5a | **ERROR** → exchange FAILED (`COMPLIANCE_UNAVAILABLE`) + evento + `DELETE idempotency_keys` → **503** | — |
| 5b | **Saldo insuficiente** (`available < source_amount` releído bajo bloqueo) → FAILED (`INSUFFICIENT_FUNDS`) + evento + `DELETE` de la clave → **422** | — |
| 5c | **LOW/MEDIUM** → `applyMovement` USDT DEBIT AVAILABLE, `applyMovement` XAUT CREDIT AVAILABLE → exchange COMPLETED con `risk_level` (y `requires_follow_up` si es MEDIUM) → cotización USED → evento → se guarda la respuesta 201 | — |
| 5d | **HIGH** → `applyMovement` USDT DEBIT AVAILABLE + CREDIT HELD → PENDING_REVIEW → cotización USED → evento → se guarda la respuesta 201 | — |
| 6 | COMMIT | |

Si algo inesperado lanza una excepción en Tx2, se hace ROLLBACK y la operación queda en PROCESSING con la clave "en
curso". Ese es exactamente el caso que cubre la recuperación documentada en D9 (ver sección 8).

## 6. Flujo de aprobar y rechazar

Una sola transacción:

1. `SELECT exchange FOR UPDATE`. Si no existe: 404. Si no está en PENDING_REVIEW: 409 `EXCHANGE_NOT_PENDING`.
2. Leer la cotización (sin bloqueo: sus montos son inmutables).
3. `SELECT wallets … ORDER BY id FOR UPDATE`.
4. Según la acción:
   - **Aprobar:** USDT DEBIT HELD + XAUT CREDIT AVAILABLE → COMPLETED.
   - **Rechazar:** USDT DEBIT HELD + USDT CREDIT AVAILABLE → REJECTED.
5. `INSERT compliance_decisions`. El `UNIQUE(exchange_id)` y la FK de rol son el respaldo en la base.
6. Insertar el evento con `actor_id` y `reason`, y hacer COMMIT. Responder 200 con el detalle de la operación.

No se valida el vencimiento de la cotización: se conserva el precio original (R13).

## 7. Estrategia de concurrencia

**Orden global de bloqueos:** exchange → quote → wallets (ordenadas por `id`). Ninguna transacción toma bloqueos en
otro orden. Tx1 solo bloquea la cotización (más la entrada de su propia clave de idempotencia, que ninguna otra
transacción bloquea después). Por eso no puede haber ciclos.

| Amenaza | Mecanismo principal | Respaldo en la base |
| --- | --- | --- |
| **Doble gasto**: dos intercambios con cotizaciones distintas sobre el mismo saldo. | Tx2 bloquea las wallets con `FOR UPDATE` y vuelve a leer `available` antes de debitar; la segunda transacción espera a la primera y ve el saldo ya descontado. | `CHECK (available >= 0)` aborta todo si algo se escapara. |
| **Doble uso de una cotización**: dos claves distintas con la misma cotización. | Tx1 bloquea la cotización con `FOR UPDATE` y comprueba si ya tiene un exchange vivo (paso 3). | Índice único parcial `exchanges_quote_live_uq`. El trigger impide USED → ACTIVE. |
| **Idempotencia simultánea**: la misma clave dos veces a la vez. | `INSERT … ON CONFLICT DO NOTHING` sobre la PK `(user_id, key)`: la segunda petición espera el commit de la primera Tx1 y luego recibe IN_PROGRESS o la respuesta reproducida. | PK de `idempotency_keys` + `exchanges_idem_live_uq`. |
| **Doble decisión**: aprobar y rechazar a la vez. | `FOR UPDATE` sobre el exchange y comprobación de PENDING_REVIEW. | `UNIQUE (compliance_decisions.exchange_id)` + trigger de la máquina de estados. |
| **Movimiento duplicado** dentro de una operación. | El código aplica cada movimiento una sola vez. | `UNIQUE (exchange_id, wallet_id, entry_type, balance_type)`. |
| **Recuperación contra una Tx2 lenta** (D9). | El timeout del servicio de cumplimiento (2 s) es mucho menor que el umbral de recuperación (por ejemplo, 5 min); Tx2 verifica PROCESSING bajo bloqueo. | Trigger: FAILED es terminal. |

Nivel de aislamiento: **READ COMMITTED** (el valor por defecto) más bloqueos explícitos. Es más fácil de explicar que
SERIALIZABLE y no requiere lógica de reintento por fallos de serialización.

## 8. Recuperación de operaciones huérfanas (D9, solo documentada)

Un job periódico tomaría las operaciones con `status = 'PROCESSING' AND created_at < now() - interval '5 minutes'` y,
por cada una, en una transacción: `FOR UPDATE`, comprobar que siga en PROCESSING, marcarla FAILED
(`RECOVERY_TIMEOUT`), insertar el evento y borrar la clave de idempotencia. Como no se movió ningún saldo, no hay nada
que revertir en el ledger.

## 9. Matriz de pruebas

Todas las pruebas e2e van con supertest contra la base `exchange_test` real. Las unitarias cubren solo funciones
puras.

| ID | Escenario (enunciado 9.5) | Tipo | Preparación | Verificación |
| --- | --- | --- | --- | --- |
| **a** | Intercambio LOW exitoso (999,99) | e2e | Semilla | 201 COMPLETED, risk LOW, sin seguimiento; USDT 9.000,01; XAUT 0,39599604; 2 movimientos con before/after correctos; cotización USED; eventos PROCESSING → COMPLETED. |
| **b** | MEDIUM con seguimiento (1.000 y 5.000) | e2e | Semilla | 201 COMPLETED, `requires_follow_up = true`, risk MEDIUM. |
| **c** | Saldo insuficiente (10.000,00000001) | e2e | Semilla | 422 INSUFFICIENT_FUNDS; saldos intactos; no hay exchange; la clave se libera (reintentar con la misma clave vuelve a evaluar). |
| **d** | Cotización vencida | e2e | Cotización insertada por SQL con `expires_at` en el pasado (el trigger impide editar `expires_at`, así que se inserta así desde el principio) | 422 QUOTE_EXPIRED; cotización EXPIRED; saldos intactos. |
| **e** | Misma clave y mismo contenido | e2e | Un intercambio LOW | La segunda respuesta es idéntica (mismo status y body) y lleva `Idempotent-Replayed: true`; sigue habiendo un solo exchange y 2 movimientos. |
| **f** | Misma clave con otro contenido | e2e | Un intercambio y luego otra cotización con la misma clave | 409 IDEMPOTENCY_KEY_MISMATCH; sin efectos. |
| **g** | HIGH retenida (5.000,01) | e2e | Semilla | 201 PENDING_REVIEW; available 4.999,99; held 5.000,01; total 10.000; movimientos DEBIT AVAILABLE y CREDIT HELD; cotización USED. |
| **h** | Aprobación de la retenida | e2e | g | 200 COMPLETED; held 0; XAUT 1,98000396; existe `compliance_decisions`; evento con actor compliance-001. |
| **i** | Rechazo y liberación del saldo | e2e | g | 200 REJECTED; available 10.000; held 0; XAUT 0; motivo guardado; la cotización sigue USED. |
| **j** | Aprobación por alguien sin rol de Cumplimiento | e2e | g | user-001 → 403; sin cambios. |

Casos borde y extras:

| ID | Caso | Tipo | Verificación |
| --- | --- | --- | --- |
| B1 | Tabla de montos de la spec (sección 7) | unit | `calculateQuote` y `riskLevelFor` devuelven exactamente esos valores, incluidos los redondeos ↑ y ↓. |
| B2 | 0,00002525 / 0,00002526 | e2e | 422 AMOUNT_TOO_SMALL / 201. |
| B3 | Monto inválido (9 decimales, 0, negativo, número JSON) | e2e | 400. |
| B4 | 10.000 exactos | e2e | PENDING_REVIEW con disponible 0. |
| B5 | 401 sin encabezado o con usuario inexistente; COMPLIANCE en POST /quotes → 403; USER en /compliance/pending → 403 | e2e | Códigos correctos. |
| B6 | El servicio de cumplimiento falla | e2e | Con `FailingComplianceProvider` vía `overrideProvider`: 503; exchange FAILED con `compliance_check` ERROR; saldos intactos; la cotización sigue ACTIVE; **misma clave** con el provider normal → 201 COMPLETED. |
| B7 | Reutilizar una cotización ya USED con otra clave | e2e | 409 QUOTE_ALREADY_USED. |
| B8 | Ver un exchange o una wallet ajena | e2e | 404. |
| B9 | Aprobar algo que no está pendiente; rechazar sin motivo | e2e | 409; 400. |
| B10 | Conciliación | e2e (helper que se ejecuta al final de a, g, h, i) | Para cada wallet, la suma de movimientos por `balance_type` es igual a `available` y `held`. |
| B11 | Inmutabilidad | e2e (SQL directo) | UPDATE o DELETE sobre `ledger_entries` falla; un UPDATE del precio de la cotización falla. |
| B12 *(opcional)* | Concurrencia: dos HIGH de 6.000 en paralelo | e2e | `Promise.all`: exactamente un 201 y un 422; held = 6.000; available = 4.000. |
| B13 *(opcional)* | Concurrencia: misma clave en paralelo | e2e | Exactamente un exchange; la otra respuesta es 409 IN_PROGRESS o la reproducción. |
| B14 *(opcional)* | Aprobar una HIGH con la cotización ya vencida | e2e | Cotización insertada con `expires_at = now() + 1 s`, ejecutar, esperar 1,5 s y aprobar → COMPLETED con el precio original. |

Organización de los archivos:

- `test/unit/money.spec.ts`
- `test/e2e/auth.e2e-spec.ts`
- `test/e2e/quotes.e2e-spec.ts`
- `test/e2e/exchanges.e2e-spec.ts`
- `test/e2e/compliance.e2e-spec.ts`
- `test/e2e/integrity.e2e-spec.ts`
- Helpers en `test/helpers.ts`: `createApp(overrides?)`, `resetDb()`, `quote(amount)`, `exchange(quoteId, key)`,
  `insertQuote({ amount, expiresAt })` y `assertReconciled()`.

## 10. Esquema del README

```
# Exchange USDT-SBX → XAUT-SBX
1.  Resumen (3 líneas)
2.  Ejecución en 3 comandos: pnpm install · pnpm run up · pnpm test   (requisitos: Node 22, pnpm, Docker)
3.  Usuarios de prueba (user-001, compliance-001) y cómo autenticarse (X-User-Id)
4.  Ejemplos de consumo (curl): cotizar → intercambiar LOW / HIGH → aprobar / rechazar; enlace a Swagger /docs
5.  Arquitectura: diagrama (docs/diagram.mmd), módulos y capas, flujo de POST /exchanges en dos transacciones
6.  Tecnologías y por qué
7.  Modelo de datos y reglas de integridad (enlace a migrations/001_schema.sql)
8.  Decisiones técnicas (resumen de D1–D16 con enlace a docs/spec.md)
9.  Concurrencia e idempotencia (resumen de la sección 7 del plan)
10. Supuestos y limitaciones
11. Mejoras para producción: autenticación real (OIDC + mTLS entre servicios, el rol sale del token), recuperación de
    huérfanos, outbox, reintentos con backoff y circuit breaker para cumplimiento, partida doble, observabilidad,
    permisos de la base de datos (sin UPDATE directo a wallets ni TRUNCATE)
12. Evolución a partida doble (cuentas de tesorería, comisión y proveedor; asiento balanceado)
13. Respuestas de diseño (sección 10)
    a. Emisión y colocación por tramos ........ [pendiente]
    b. Transferencias internas ................ [pendiente]
    c. Custodia y conciliación omnibus ........ [pendiente]
    d. Indisponibilidad de cumplimiento ....... [pendiente]
    e. Controles antes de producción .......... [pendiente]
    f. Emisión on-chain: separación ........... [pendiente]
14. Mockup (enlace o archivo)
15. Uso de IA y tiempo empleado (desde docs/ia_y_tiempo.md)
```

## 11. Riesgos y mitigaciones

| Riesgo | Mitigación |
| --- | --- |
| El día 1 se queda corto. | Las pruebas opcionales (B12–B14) y Swagger detallado son lo primero que se recorta. Los 10 escenarios obligatorios van primero. |
| Que `numeric` se convierta por accidente en `Number`. | `pg` devuelve numeric como string por defecto y no se configura ningún type parser. Los DTOs exigen string y los helpers de prueba comparan strings. |
| Pruebas inestables por compartir la base. | `--runInBand` + `TRUNCATE` antes de cada prueba. Las pruebas de concurrencia usan sus propias cotizaciones. |
| Constraints con nombres automáticos (`quotes_check2`) poco legibles en los errores. | Solo `exchanges_quote_live_uq` se traduce a un código de negocio, y tiene nombre explícito. El resto son defensas que no deberían dispararse. |
