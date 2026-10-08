# Intercambio USDT-SBX → XAUT-SBX

Backend de una plataforma de activos digitales con **wallets internas**: el usuario cotiza y ejecuta un intercambio de USDT-SBX por
XAUT-SBX; los saldos solo cambian mediante movimientos de un **ledger inmutable**; cada operación pasa por un servicio simulado de
**cumplimiento** (LOW / MEDIUM / HIGH) y las de riesgo alto quedan retenidas hasta que una persona de Cumplimiento las apruebe o rechace.

NestJS + TypeScript · PostgreSQL con SQL directo (`pg`, sin ORM) · montos con `decimal.js` · pruebas contra un PostgreSQL real en Docker.

## 1. Ejecución en tres comandos

Requisitos: **Node 22**, **pnpm** (`corepack enable` instala la versión fijada en `package.json`) y **Docker** en ejecución.

```bash
pnpm install     # 1. instala las dependencias
pnpm run up      # 2. levanta PostgreSQL, aplica migraciones y semilla, e inicia la API en http://localhost:3000
pnpm test        # 3. corre todas las pruebas (puede ejecutarse con la API levantada: usa su propia base)
```

- `pnpm run up` ejecuta `docker compose up -d --wait db` (PostgreSQL 16 en el puerto **5433**, para no chocar con uno local), luego
  `scripts/migrate.ts` y por último la API. **Swagger UI: http://localhost:3000/docs**.
- `pnpm test` levanta la base si hace falta, **recrea una base propia (`exchange_test`) y la migra desde cero**, y ejecuta Jest. Nunca toca los
  datos de desarrollo. Las pruebas usan PostgreSQL real; el único doble es el servicio de cumplimiento, que el enunciado pide simular.

**Inicialización de la base de datos.** Son archivos SQL numerados que aplica `scripts/migrate.ts` en orden y registra en `schema_migrations`
(idempotente): `001_schema.sql` (esquema completo, **fuente de verdad**) y `002_seed.sql` (usuarios, activos, wallets y el depósito inicial).
Para volver al estado inicial: `docker compose down -v && pnpm run up`.

Variables de entorno (todas opcionales; los valores por defecto están en `.env.example`):

| Variable | Por defecto | Para qué |
|---|---|---|
| `DATABASE_URL` | `postgres://exchange:exchange@localhost:5433/exchange` | Conexión a PostgreSQL |
| `PORT` | `3000` | Puerto de la API |
| `QUOTE_TTL_SECONDS` | `30` | Vigencia de una cotización |
| `COMPLIANCE_TIMEOUT_MS` | `2000` | Tiempo máximo de espera al servicio de cumplimiento |
| `COMPLIANCE_MOCK_FAIL` | `false` | `true` simula que el servicio de cumplimiento está caído |

## 2. Usuarios de prueba y autenticación

| Usuario | Rol | USDT-SBX | XAUT-SBX |
|---|---|---|---|
| `user-001` | USER | 10.000 | 0 |
| `compliance-001` | COMPLIANCE | 0 | 0 |

La identidad se envía en el encabezado **`X-User-Id`** (en Swagger UI: botón *Authorize*). Sin él, o con un usuario inexistente: **401**. Con un rol
sin permiso para la ruta: **403** (USER no puede tocar `/compliance/*`; COMPLIANCE no puede cotizar ni intercambiar).

**Cómo se sustituiría en producción.** `X-User-Id` no autentica nada: cualquiera puede escribirlo. En producción se reemplaza por **OIDC/OAuth2**: el
cliente obtiene un JWT del proveedor de identidad, la API valida su firma (JWKS), su emisor, audiencia y expiración, y el **rol sale de los *claims*
del token** (no de una consulta por id). Cumplimiento se autenticaría además con MFA y desde la red interna. El cambio queda aislado en un solo
sitio: el `AuthGuard` (`src/common/auth/auth.guard.ts`) lee hoy el encabezado y deja el usuario en `req.user`; con tokens leería el JWT y dejaría el
mismo `req.user`, sin tocar los controladores, el `RolesGuard` ni la lógica de negocio.

## 3. La API

| Método y ruta | Rol | Qué hace |
|---|---|---|
| `GET /wallets` | USER, COMPLIANCE | Mis wallets: disponible, retenido y total |
| `GET /wallets/:id/movements` | USER, COMPLIANCE | Movimientos de una wallet, con saldo anterior y posterior |
| `POST /quotes` | USER | Cotiza USDT-SBX por XAUT-SBX (precio 2.500, comisión 1 %, vigencia 30 s) |
| `POST /exchanges` | USER | Ejecuta una cotización. Exige el encabezado `Idempotency-Key` |
| `GET /exchanges` | USER, COMPLIANCE | Mis operaciones (Cumplimiento: las de todos, con `?userId=`) |
| `GET /exchanges/:id` | USER, COMPLIANCE | Detalle y trazabilidad completa de una operación |
| `GET /compliance/exchanges/pending` | COMPLIANCE | Bandeja de operaciones retenidas |
| `PATCH /compliance/exchanges/:id/approve` | COMPLIANCE | Aprueba una retenida (motivo opcional) |
| `PATCH /compliance/exchanges/:id/reject` | COMPLIANCE | Rechaza una retenida (motivo obligatorio) |

Los **montos viajan siempre como string** (`"2500.00000000"`); un número JSON en un monto es un 400, porque `JSON.parse` lo convertiría a punto flotante.
Todos los errores tienen la forma `{ "error": { "code", "message", "details"? } }` con un `code` estable. La especificación completa (códigos, estados y
casos borde) está en [`docs/spec.md`](docs/spec.md), y navegable en Swagger UI.

### Ejemplos de consumo

Con la API corriendo (`pnpm run up`) y `jq` instalado, en otra terminal, **en orden y en la misma sesión** (los bloques comparten variables). Parten del estado inicial de la base: para
repetirlos desde cero, `docker compose down -v && pnpm run up`. Cada bloque se ejecutó tal cual contra el servidor real.

**Cotizar y ejecutar** 2.500 USDT-SBX (riesgo MEDIUM: se ejecuta y queda marcada para seguimiento):

```bash
H='Content-Type: application/json'
R=$(curl -s -X POST localhost:3000/quotes -H "$H" -H 'X-User-Id: user-001' \
  -d '{"source_asset":"USDT-SBX","target_asset":"XAUT-SBX","source_amount":"2500"}')
echo "$R" | jq '{source_amount, fee_amount, net_amount, target_amount, status, expires_at}'
Q=$(echo "$R" | jq -r .id)
curl -s -X POST localhost:3000/exchanges -H "$H" -H 'X-User-Id: user-001' -H 'Idempotency-Key: ejemplo-1' \
  -d "{\"quote_id\":\"$Q\"}" | jq '{status, risk_level, requires_follow_up, movements: [.movements[] | {asset, entry_type, amount}]}'
```

**Idempotencia:** repetir la misma clave devuelve la respuesta original, sin duplicar movimientos (encabezado `Idempotent-Replayed: true`); la misma clave con
otra cotización da 409.

```bash
curl -s -i -X POST localhost:3000/exchanges -H "$H" -H 'X-User-Id: user-001' -H 'Idempotency-Key: ejemplo-1' \
  -d "{\"quote_id\":\"$Q\"}" | grep -i -E '^HTTP|idempotent-replayed'
Q2=$(curl -s -X POST localhost:3000/quotes -H "$H" -H 'X-User-Id: user-001' \
  -d '{"source_asset":"USDT-SBX","target_asset":"XAUT-SBX","source_amount":"50"}' | jq -r .id)
curl -s -X POST localhost:3000/exchanges -H "$H" -H 'X-User-Id: user-001' -H 'Idempotency-Key: ejemplo-1' \
  -d "{\"quote_id\":\"$Q2\"}" | jq -c .error.code
```

**Operación retenida (HIGH) y decisión de Cumplimiento** (5.000,01 USDT-SBX: queda `PENDING_REVIEW` con el saldo retenido):

```bash
Q3=$(curl -s -X POST localhost:3000/quotes -H "$H" -H 'X-User-Id: user-001' \
  -d '{"source_asset":"USDT-SBX","target_asset":"XAUT-SBX","source_amount":"5000.01"}' | jq -r .id)
E=$(curl -s -X POST localhost:3000/exchanges -H "$H" -H 'X-User-Id: user-001' -H 'Idempotency-Key: ejemplo-2' \
  -d "{\"quote_id\":\"$Q3\"}" | jq -r .id)
curl -s localhost:3000/wallets -H 'X-User-Id: user-001' | jq -c '.[] | select(.asset=="USDT-SBX") | {available, held, total}'
curl -s localhost:3000/compliance/exchanges/pending -H 'X-User-Id: compliance-001' | jq -c '.[] | {user_id, source_amount, risk_level}'
curl -s -X PATCH "localhost:3000/compliance/exchanges/$E/approve" -H "$H" -H 'X-User-Id: compliance-001' \
  -d '{"reason":"Origen de fondos verificado"}' | jq '{status, decision: .decision.decision, reviewer: .decision.reviewer_id}'
```

**Errores:** un USER no puede aprobar (403) y una operación ya decidida no se decide otra vez (409).

```bash
curl -s -X PATCH "localhost:3000/compliance/exchanges/$E/approve" -H "$H" -H 'X-User-Id: user-001' -d '{}' | jq -c .error.code
curl -s -X PATCH "localhost:3000/compliance/exchanges/$E/approve" -H "$H" -H 'X-User-Id: compliance-001' -d '{}' | jq -c .error.code
```

El recorrido completo de los diez escenarios del enunciado, con los resultados esperados, está en
[`docs/pruebas_manuales.md`](docs/pruebas_manuales.md).

## 4. Arquitectura

```mermaid
flowchart LR
  U["Usuario<br/>(rol USER)"]
  C["Oficial de Cumplimiento<br/>(rol COMPLIANCE)"]

  subgraph API["API NestJS (autenticación simplificada: X-User-Id)"]
    direction TB
    AUTH["Guards globales<br/>401 sin usuario<br/>403 sin rol"]
    QS["Servicio de cotización<br/>POST /quotes<br/>precio 2.500<br/>comisión 1 %<br/>vigencia 30 s"]
    EX["Intercambios<br/>POST /exchanges<br/>(idempotente)<br/>GET /exchanges"]
    WS["Wallets<br/>GET /wallets<br/>movimientos"]
    REV["Revisión de Cumplimiento<br/>bandeja<br/>aprobar / rechazar"]
    CC["Cliente de cumplimiento<br/>timeout, nunca lanza"]
    LED["LedgerRepository<br/>único punto que<br/>mueve saldos"]
  end

  MOCK["Servicio MOCK<br/>de cumplimiento<br/>LOW / MEDIUM / HIGH<br/>según el monto"]

  subgraph DB["Base de datos PostgreSQL"]
    direction TB
    W[("Wallets<br/>disponible, retenido<br/>y total")]
    L[("Ledger<br/>movimientos inmutables<br/>con saldo anterior<br/>y posterior")]
    O[("Cotizaciones y operaciones<br/>claves de idempotencia<br/>eventos y decisiones<br/>consultas a cumplimiento")]
  end

  U --> AUTH
  C --> AUTH
  AUTH --> QS
  AUTH --> EX
  AUTH --> WS
  AUTH --> REV

  QS --> O
  EX -->|"Tx1: reservar"| O
  EX -.->|"consulta de riesgo"| CC
  CC -.-> MOCK
  EX -->|"Tx2: aplicar"| LED
  REV -->|"una transacción"| LED
  REV --> O
  LED --> W
  LED --> L
  WS --> W
  WS --> L
```

Módulos (`src/`), cada uno con controller (HTTP y validación), service (reglas y transacciones) y repository (SQL), sin más capas:

| Módulo | Responsabilidad |
|---|---|
| `common/` | Pool de `pg` y `withTransaction`; guards de autenticación (401) y de rol (403); `BusinessError` y su filtro; cálculo de la cotización con `decimal.js`; Swagger |
| `wallets/` | Consulta de wallets y movimientos. Contiene el `LedgerRepository`: **la única función que modifica saldos** (una prueba vigila que siga así) |
| `quotes/` | Cotizaciones |
| `exchanges/` | Ejecución en dos transacciones, idempotencia, consultas |
| `compliance-service/` | El servicio **automático** de monitoreo: contrato, mock y cliente con timeout. Responde LOW / MEDIUM / HIGH |
| `compliance-review/` | La revisión **humana** (rol COMPLIANCE): bandeja, aprobar y rechazar |

Las dos piezas «de cumplimiento» no tienen relación de código: el servicio automático clasifica el riesgo; la persona decide sobre las operaciones HIGH. Solo se
encuentran en el estado `PENDING_REVIEW`.

### El flujo de `POST /exchanges`: dos transacciones

```mermaid
sequenceDiagram
  autonumber
  actor U as Usuario (USER)
  participant API as API
  participant DB as PostgreSQL
  participant CS as Servicio de cumplimiento (mock)
  actor C as Oficial (COMPLIANCE)

  U->>API: POST /exchanges {quote_id} + Idempotency-Key

  rect rgb(232, 242, 255)
    Note over API,DB: Tx1 - corta, sin llamadas externas
    API->>DB: reservar la clave de idempotencia
    API->>DB: bloquear la cotización (FOR UPDATE)
    API->>DB: validar: ¿en uso? ¿usada? ¿vencida? ¿saldo preliminar?
    API->>DB: crear la operación en PROCESSING + evento
  end

  Note over API,CS: Fuera de toda transacción: no hay filas bloqueadas ni conexiones abiertas
  API->>CS: evaluar el riesgo del monto bruto (con timeout)
  CS-->>API: LOW, MEDIUM o HIGH (o un error)

  rect rgb(232, 255, 238)
    Note over API,DB: Tx2 - atómica
    API->>DB: bloquear operación, cotización y wallets (en ese orden, wallets por id)
    API->>DB: releer el saldo bajo bloqueo y registrar la consulta
    alt cumplimiento falló, o el saldo ya no alcanza
      API->>DB: operación FAILED, sin movimientos, libera la clave
      API-->>U: 503 o 422 (la cotización sigue disponible)
    else LOW o MEDIUM
      API->>DB: ledger: débito de USDT + crédito de XAUT, operación COMPLETED, cotización USED
      API-->>U: 201 COMPLETED (MEDIUM: requires_follow_up = true)
    else HIGH
      API->>DB: ledger: débito del disponible + crédito del retenido, operación PENDING_REVIEW, cotización USED
      API-->>U: 201 PENDING_REVIEW
    end
  end

  opt Solo HIGH: decisión humana
    C->>API: PATCH /compliance/exchanges/id/approve o reject
    API->>DB: una transacción: bloquear, mover el saldo, registrar la decisión y el evento
    alt aprobar
      Note over API,DB: se debita lo retenido y se acredita el XAUT - COMPLETED
    else rechazar
      Note over API,DB: se libera lo retenido y no se acredita XAUT - REJECTED
    end
    API-->>C: 200 con el detalle de la operación
  end
```

**Por qué dos transacciones.** Llamar a un servicio externo con una transacción abierta retendría filas bloqueadas durante una espera que, en producción, sería de
red. Así, la consulta a cumplimiento ocurre entre ambas, sin ningún bloqueo. Contrapartida: si el proceso se cae entre las dos, la operación queda en
`PROCESSING` (ver limitaciones).

**Estados.** Cotización: `ACTIVE → USED | EXPIRED` (nunca vuelve atrás). Operación: `PROCESSING → COMPLETED | PENDING_REVIEW | FAILED` y
`PENDING_REVIEW → COMPLETED | REJECTED`. Ambas máquinas están **también en triggers de la base de datos**, no solo en el código.

## 5. Tecnologías y por qué

| Tecnología | Por qué |
|---|---|
| **NestJS 11** + TypeScript estricto | Los *guards* resuelven 401/403 de forma declarativa y la inyección de dependencias permite sustituir el servicio de cumplimiento en las pruebas. Se fija en la 11: la 12 es solo ESM y Jest 30 no la carga |
| **PostgreSQL 16** con `pg` y SQL directo (sin ORM) | Los bloqueos (`FOR UPDATE` en un orden fijo), los índices parciales y los triggers son el corazón de la integridad; con SQL explícito se ven y se pueden defender línea a línea |
| **`decimal.js`** | Aritmética decimal exacta con redondeos explícitos (comisión hacia arriba, XAUT hacia abajo). Nunca `Number`; las columnas `numeric` llegan de `pg` como texto y así siguen hasta la API |
| **Jest + supertest** sobre PostgreSQL real | Las reglas de integridad viven en la base; probarlas contra una simulación no probaría nada |
| **Swagger** (`@nestjs/swagger`) | Documentación navegable en `/docs`, verificada por una prueba contra la API real |
| **Docker Compose**, **pnpm** | Un servicio (la base) y tres comandos |

## 6. Modelo de datos e integridad

Diagrama entidad-relación: [`docs/img/diagram-er.png`](docs/img/diagram-er.png) (fuente [`docs/diagram-er.mmd`](docs/diagram-er.mmd)). El esquema completo es
[`migrations/001_schema.sql`](migrations/001_schema.sql), y es la única fuente de verdad. Lo que la **base de datos** garantiza por sí misma, aunque el código fallara:

- **Los saldos nunca son negativos** (`CHECK`) y solo cambian con un movimiento del ledger: una wallet no puede nacer con saldo; el saldo inicial entra como un movimiento.
- **El ledger, las consultas a cumplimiento, las decisiones y los eventos son de solo inserción** (un trigger rechaza `UPDATE` y `DELETE`). Wallets, cotizaciones y operaciones tampoco se borran.
- **Cada movimiento cuadra**: `saldo_posterior = saldo_anterior ± monto`, y no puede repetirse el mismo movimiento de una operación.
- **La cotización es inmutable** (precio, comisión, montos y vencimiento); solo cambia de estado, y solo `ACTIVE → USED | EXPIRED`.
- **Las máquinas de estados** de cotización y operación están aplicadas por trigger; una operación solo puede nacer en `PROCESSING`.
- **Una cotización tiene como máximo una operación viva** (índice único parcial; las `FAILED` quedan fuera).
- **Solo un usuario con rol COMPLIANCE puede ser revisor** (clave foránea compuesta), una sola decisión por operación, y rechazar exige un motivo.

## 7. Decisiones técnicas

Cada una tiene su justificación completa en [`docs/spec.md`](docs/spec.md) (sección 3).

| | Decisión |
|---|---|
| D1 | **Retener** = débito del disponible + crédito del retenido en la misma wallet (sin tipos HOLD/RELEASE); liberar, al revés |
| D2 | El saldo inicial es un **crédito del ledger** con referencia `INITIAL_DEPOSIT` |
| D3 | La operación nace en `PROCESSING`; se elimina `CREATED` (no se distinguiría de `PROCESSING`) |
| D4 | No existe `RESERVED`: una cotización `USED` no se reutiliza jamás, ni tras un rechazo |
| D5 | Entrada de hasta 8 decimales; comisión redondeada **hacia arriba**, XAUT **hacia abajo** |
| D6 / D13 | `GET /exchanges`: un USER ve lo suyo; si pide el `userId` de otro, 403 explícito |
| D7 | Si cumplimiento falla: operación `FAILED`, sin movimientos, 503, y la cotización sigue disponible |
| D8 | La cotización pasa a `USED` en la **segunda** transacción, para poder reintentar tras una falla |
| D9 | Dos transacciones, con la consulta externa fuera de ambas |
| D10 | La operación no copia los montos: los lee de la cotización, cuyas columnas son inmutables por trigger |
| D11 | Idempotencia: se guardan los resultados definitivos; los transitorios (503, saldo insuficiente) **liberan la clave** para reintentar |
| D12 | Un monto cuyo XAUT daría 0 se rechaza (`AMOUNT_TOO_SMALL`) |
| D15 / D16 | Tres comandos; `migrations/001_schema.sql` es la única fuente de verdad del esquema |
| D17 | El rol COMPLIANCE también tiene wallets, **siempre en cero** (lo exige la tabla de datos del enunciado); la segregación se aplica con permisos, no con su ausencia |
| D18 | Solo se soporta USDT-SBX → XAUT-SBX (el enunciado define todo en ese sentido) |
| D19 | El servicio de cumplimiento es **dueño de sus umbrales**; la lógica principal solo confía en su respuesta |

## 8. Concurrencia e idempotencia

**Cómo se evita que dos solicitudes simultáneas consuman el mismo saldo.** La segunda transacción bloquea las wallets del usuario con `SELECT … FOR UPDATE`, en un
orden global fijo (operación → cotización → wallets ordenadas por `id`, lo que impide interbloqueos), y **vuelve a leer el saldo bajo ese bloqueo**. La segunda
solicitud espera a que la primera termine y ve el saldo ya descontado. El nivel de aislamiento es el predeterminado (`READ COMMITTED`) más bloqueos explícitos: es más
fácil de razonar que `SERIALIZABLE` y no necesita reintentos por fallos de serialización. Como **última defensa**, el `CHECK (available >= 0)` aborta toda la
transacción si algo se escapara. Hay pruebas HTTP con peticiones simultáneas que lo demuestran.

| Amenaza | Mecanismo principal | Respaldo en la base |
|---|---|---|
| Doble gasto (cotizaciones distintas, mismo saldo) | `FOR UPDATE` de las wallets y relectura del saldo | `CHECK` de saldo no negativo |
| La misma cotización con claves distintas | `FOR UPDATE` de la cotización | Índice único parcial de operaciones vivas |
| La misma `Idempotency-Key` a la vez | `INSERT … ON CONFLICT DO NOTHING` sobre la clave primaria: la segunda petición espera, y luego ve «en curso» o la respuesta guardada | Clave primaria `(user_id, key)` |
| Aprobar y rechazar a la vez | `FOR UPDATE` de la operación y comprobación de `PENDING_REVIEW` | `UNIQUE` en las decisiones y trigger de estados |

**Idempotencia (`Idempotency-Key`, solo en `POST /exchanges`).** Misma clave y mismo contenido → la respuesta original, reproducida, sin duplicar movimientos. Misma clave
y otro contenido → 409. La clave se guarda en la base de datos, con una huella del contenido. Los errores definitivos (cotización inexistente, usada o vencida) se
guardan y se reproducen; los transitorios (cumplimiento caído, saldo insuficiente) **liberan la clave**, para que el cliente reintente con la misma.

## 9. Supuestos y limitaciones

**Supuestos** (detalle en [`docs/spec.md`](docs/spec.md) §8):
- El riesgo se evalúa sobre el **monto bruto** de origen (comisión incluida).
- La comisión **no se acredita** a ninguna cuenta: no se modelan tesorería ni proveedor de liquidez (el enunciado lo permite).
- Los usuarios de la semilla se consideran aprobados: no hay KYC. La API no crea usuarios, wallets ni depósitos.
- El vencimiento de una cotización es *perezoso*: se marca `EXPIRED` cuando alguien intenta usarla; no hay un proceso que las expire.
- `GET /exchanges` y la bandeja admiten `?limit=` (1 a 200, 50 por defecto): el enunciado no habla de paginación; es solo un tope.

**Limitaciones conocidas:**
- **Recuperación de operaciones huérfanas: solo documentada, no implementada.** Si el proceso se cae entre Tx1 y Tx2, la operación queda en `PROCESSING` con su clave
  «en curso» y el reintento da `IDEMPOTENCY_IN_PROGRESS`. El plan: un proceso periódico que marque `FAILED` las `PROCESSING` con más de N minutos (sin saldos que revertir,
  porque Tx1 no mueve dinero) y libere su clave. Tx2 ya está preparada: comprueba bajo bloqueo que siga en `PROCESSING`.
- **La autenticación es una simulación** (ver §2): no es segura.
- Un solo par (USDT-SBX → XAUT-SBX) y un solo proveedor simulado; sin reintentos ni *circuit breaker* hacia cumplimiento (ver §10).
- La clave de idempotencia no expira (el enunciado no lo exige).
- Una sola instancia de la API probada; sin *rate limiting*, sin métricas.

## 10. Mejoras necesarias para producción

**Si el servicio de cumplimiento falla** (enunciado 3.7). Hoy: timeout de 2 s, la operación queda `FAILED`, no se mueve ningún saldo, se responde 503 y el cliente
reintenta con la misma clave. Es *fail-closed*: **nada se ejecuta sin validación previa**. En producción se añadiría: reintentos con espera exponencial *solo* para la
consulta (es idempotente); un *circuit breaker* para no saturar un proveedor caído; y, si la indisponibilidad es larga, un estado `AWAITING_COMPLIANCE` con una cola
para procesar después las operaciones que ya fueron aceptadas, en lugar de pedirle al usuario que reintente. Alertas sobre la tasa de errores y la latencia.

Además:
- **Autenticación real** (§2) y autorización por *scopes*; secretos en un gestor, no en variables de entorno.
- **Recuperación de huérfanas** (§9), y una conciliación periódica: la suma del ledger de cada wallet contra su saldo, y alerta si alguna difiere.
- **Permisos en la base**: el rol de la aplicación sin `UPDATE` directo sobre `wallets` ni `TRUNCATE`, y un rol aparte para las migraciones. Réplicas, copias de seguridad y
  recuperación a un punto en el tiempo.
- **Auditoría a prueba de manipulación**: encadenar con un hash cada movimiento del ledger y anclar periódicamente el hash fuera de la base.
- **Observabilidad**: logs estructurados con el id de la operación, métricas (latencia de Tx1 y Tx2, esperas de bloqueo, operaciones en `PROCESSING` antiguas) y trazas.
- **Resiliencia**: *rate limiting* por usuario, expiración de claves de idempotencia, límites de tamaño de petición, y particionar el ledger por fecha cuando crezca.
- **Transmisión de eventos** (patrón *outbox*) para notificar a otros sistemas las operaciones completadas, rechazadas o retenidas.
- **TLS** de extremo a extremo y *mTLS* entre servicios.

## 11. Evolución hacia un ledger de partida doble

Hoy el ledger es **simplificado, por wallet**: cada movimiento cambia el saldo de una sola wallet y la contrapartida (de dónde sale el dinero) no se registra. Por eso
el depósito inicial aparece «de la nada» (D2) y la comisión desaparece (no se acredita a nadie).

En partida doble, **cada evento de negocio es un asiento cuyas líneas suman cero por activo**: lo que sale de unas cuentas entra en otras.

- Un **plan de cuentas**: wallets de clientes (disponible y retenido), **tesorería**, **proveedor de liquidez**, **ingresos por comisiones** y la **wallet ómnibus** de custodia.
- Dos tablas, `journal_entries` (el evento: operación, fecha, motivo) y `postings` (las líneas: cuenta, activo, monto **con signo**: negativo si sale de la cuenta, positivo si entra). Un
  *constraint trigger* diferido exige que las líneas de cada asiento sumen cero por activo; así un asiento descuadrado no se puede confirmar.
- El saldo de una cuenta deja de ser una columna que se actualiza: es la **suma de sus líneas** (con una tabla de saldos materializada y verificada contra ella).

El intercambio de 2.500 USDT-SBX, que hoy son dos movimientos, sería un asiento balanceado:

| Cuenta | Activo | Monto |
|---|---|---:|
| Wallet del usuario | USDT-SBX | −2.500,00 |
| Tesorería | USDT-SBX | +2.475,00 |
| Ingresos por comisiones | USDT-SBX | +25,00 |
| Proveedor de liquidez | XAUT-SBX | −0,99 |
| Wallet del usuario | XAUT-SBX | +0,99 |

**Cada activo suma cero:** USDT-SBX −2.500 + 2.475 + 25 = 0, y XAUT-SBX −0,99 + 0,99 = 0. Con esta convención de signos no hace falta fijar la naturaleza contable de cada cuenta
(activo, pasivo o ingreso): si se quisiera, un monto negativo equivale a un débito de una cuenta de pasivo y uno positivo, a un crédito. La comisión, que hoy desaparece, tiene su cuenta; y el
depósito inicial deja de salir de la nada: sale de la tesorería (+10.000 al usuario, −10.000 a la tesorería). **Cómo se migraría**: cada par de movimientos actuales se convierte en un asiento con su contrapartida;
`ledger_entries` se mantiene como una vista de lectura. Retener y liberar siguen siendo asientos entre las subcuentas «disponible» y «retenido» del mismo cliente.

## 12. Mockup

Mockup de baja fidelidad de las cuatro pantallas del enunciado (panel del usuario, solicitud de intercambio, resultado de la operación y bandeja de Cumplimiento):
[`docs/mockup/mockup.pdf`](docs/mockup/mockup.pdf) (una pantalla por página), con sus PNG y la fuente en [`docs/mockup/`](docs/mockup/LEEME.md). Una prueba lo cruza con la API real
(endpoints, estados, códigos de error y cifras).

## 13. Respuestas a las preguntas de diseño

Son diseño, no código entregado. Todas reutilizan los mecanismos que ya existen en esta solución (bloqueos en orden fijo, `CHECK` como última defensa, ledger
de solo inserción, idempotencia por clave, máquinas de estados en triggers).

**a) Emisión por tramos y colocación inicial, sin superar el suministro autorizado.**
Se modela el suministro como datos con invariantes en la base: `asset_supply (asset_code, authorized_supply)` y `issuance_tranches (asset_code, amount, placed, status)`. Un tramo
nace aprobado por dos personas (*maker-checker*) y recorre `DRAFT → APPROVED → OPEN → CLOSED`, con la máquina de estados aplicada por trigger, igual que la de las operaciones. Dos
`CHECK` protegen el tope: `placed <= amount` en el tramo e `issued <= authorized_supply` en el activo. Cada colocación hace, **en la misma transacción que sus movimientos del ledger**,
`UPDATE issuance_tranches SET placed = placed + $monto`: el bloqueo de esa fila serializa las colocaciones simultáneas, de modo que dos colocaciones no pueden gastar el mismo remanente
(es el mismo problema del doble gasto, resuelto con el mismo patrón), y el `CHECK` aborta lo que lo excediera. La colocación lleva `Idempotency-Key` y es de solo inserción. La conciliación
comprueba que la suma de saldos en el ledger de ese activo sea igual a lo emitido y que lo emitido no supere lo autorizado.

**b) Transferencias internas entre usuarios: atomicidad, idempotencia y trazabilidad.**
`POST /transfers` con `Idempotency-Key` (mismo mecanismo: `INSERT … ON CONFLICT` sobre `(user_id, key)`, huella del contenido y respuesta guardada). Una sola transacción: se bloquean las
**dos wallets en orden de `id`** (la misma regla que evita el interbloqueo cuando A→B y B→A ocurren a la vez), se verifica el saldo bajo bloqueo y se aplican dos movimientos con
`LedgerRepository` (débito del emisor, crédito del receptor), con `reference_type = 'TRANSFER'` y el id de la transferencia; el `UNIQUE` del ledger impide duplicar un movimiento. Así o
se confirman ambos o ninguno. Trazabilidad: tabla `transfers` con su máquina de estados y eventos con actor, más los movimientos con saldo anterior y posterior. Se rechazan la
transferencia a uno mismo y a un destinatario inexistente o sin verificar, y se aplican límites. Si el monto exige validación, se reutiliza el flujo de dos transacciones: consulta a
cumplimiento fuera de transacción y, si es de riesgo alto, retención del saldo del emisor hasta la decisión humana.

**c) Conciliar el ledger interno contra una wallet ómnibus (Fireblocks o equivalente).**
Invariante: para cada activo, `Σ (disponible + retenido) de los clientes + cuentas propias (tesorería, comisiones) = saldo de la wallet ómnibus`, ajustado por lo que está en tránsito. Un
proceso programado (y otro a demanda): (1) toma el saldo de la ómnibus por la API de Fireblocks en un instante de corte; (2) calcula el pasivo interno hasta ese mismo corte, lo que es fácil
porque el ledger es de solo inserción con `id` creciente: `SUM … WHERE id <= max(id)` da una foto consistente; (3) concilia **transacción por transacción** por el id de Fireblocks
(depósitos detectados pero aún no acreditados, retiros aprobados pero sin confirmar), con una tabla `custody_movements` que lo registra; (4) guarda cada ejecución en `reconciliation_runs`
(solo inserción) con la diferencia. Una diferencia sin explicar dispara una alerta y **congela los retiros**. Las notificaciones de Fireblocks (*webhooks*) se procesan con idempotencia por su
`txId`, y un depósito solo se acredita tras N confirmaciones. Hay además una conciliación interna (saldo de cada wallet = suma de su ledger), la misma que usan las pruebas de este proyecto.

**d) Indisponibilidad de Sumsub o Chainalysis sin permitir operaciones que requieren validación.**
Principio: **fail-closed**. Nunca se asume «riesgo bajo» si el proveedor no responde; así funciona ya esta solución (operación `FAILED`, sin movimientos, 503). En producción: tiempos máximos cortos,
reintentos con espera exponencial y *jitter* solo para consultas idempotentes, y un *circuit breaker*. Con el circuito abierto, las operaciones que requieren validación se **aceptan en
`AWAITING_COMPLIANCE`** sin mover fondos (o se responde 503 con `Retry-After`), y un proceso las reintenta cuando el proveedor vuelve, aplicando el resultado con la misma segunda transacción; las que
esperan más de un límite pasan a `FAILED` y se notifica. Se distinguen dos casos: el **KYC del usuario** (Sumsub) puede reutilizarse con una vigencia acotada, pero el **análisis de una transacción o
dirección** (Chainalysis) es por operación y **no se cachea ni se omite**. Un segundo proveedor da redundancia; la única vía manual es una decisión humana con doble aprobación, registrada en
`compliance_decisions`. Alertas por tasa de errores y latencia.

**e) Controles antes de desplegar en una plataforma regulada.**
*Técnicos:* autenticación OIDC con MFA y autorización por mínimo privilegio, con doble aprobación (*maker-checker*) en las acciones sensibles; secretos en un gestor con KMS/HSM; TLS y mTLS; en la base,
un rol de aplicación sin `UPDATE` sobre `wallets` ni `TRUNCATE` y otro para migraciones; cifrado en reposo; ledger encadenado con hash y anclado fuera de la base; registros de auditoría en
almacenamiento inmutable (WORM); *rate limiting*; análisis de dependencias y de código, y pruebas de penetración. *Operativos:* conciliación diaria con alertas; recuperación a un punto en el
tiempo con simulacros de restauración (RPO/RTO definidos); observabilidad con SLO y guardias; gestión de cambios (revisión de código y de cada migración, despliegues aprobados); plan de respuesta a
incidentes; revisión periódica de accesos. *Regulatorios:* KYC/AML, listas de sanciones y *Travel Rule*; protección de datos personales (minimización, retención); reportes para el regulador; y gestión de
riesgo de terceros (custodio, proveedores de cumplimiento).

**f) Emisión on-chain: qué mantener separado.**
Cinco componentes con **responsables y ritmos de cambio distintos**, de modo que ningún actor pueda emitir por sí solo: (1) la **lógica interna** de la plataforma (ledger, órdenes, cumplimiento): es la
fuente de verdad off-chain de las cuentas de clientes y **no guarda claves**; (2) el **contrato inteligente**: mínimo y sin lógica de negocio, con el tope de suministro impuesto *on-chain*, roles
(`MINTER`, `PAUSER`) asignados a una multifirma con *timelock*, y sin capacidad de mejora o solo mediante gobierno; (3) la **custodia** (Fireblocks, MPC o HSM): las claves y las políticas de firma (quórum,
listas permitidas, límites) viven allí, y el backend solo *solicita* transacciones por su API; (4) la **auditoría del contrato**: un tercero independiente audita un *commit* concreto, con compilación
reproducible y código verificado en el explorador, y cualquier cambio exige una nueva auditoría; (5) la **validación del activo de respaldo**: una entidad independiente certifica las reservas (prueba de
reservas, con atestaciones periódicas o un oráculo). El flujo encadena los controles: respaldo validado → tramo de emisión aprobado por dos personas → *mint* firmado por la multifirma → el backend acredita el ledger tras N
confirmaciones → conciliación (suministro *on-chain* = emitido autorizado = pasivo interno).

## 14. Uso de inteligencia artificial y tiempo empleado

**Herramienta:** Claude Code (modelos Claude Opus y Sonnet 5.x), en la terminal.

**Para qué:** análisis del enunciado y revisión crítica del esquema; redacción de la especificación, el plan y las tareas; implementación del código y de las pruebas; diagramas;
mockup; y este README. El trabajo fue guiado por especificación: la IA propuso y redactó, y **yo revisé y aprobé cada fase antes de continuar** y tomé cada decisión de diseño
(todas están en [`docs/spec.md`](docs/spec.md) con su justificación). Asumo la responsabilidad del código entregado y puedo explicar y modificar cualquier parte.

**Cómo se controló la calidad:** cada pieza se validó con *pruebas de mutación* (romper el código a propósito y comprobar que alguna prueba falla), lo que destapó varios
errores de la propia IA, que quedan registrados.

**Registro detallado** de qué hizo la IA, qué decidí yo y cuánto tomó cada fase: [`docs/ia_y_tiempo.md`](docs/ia_y_tiempo.md).

**Tiempo aproximado empleado:** ⏳ **Pendiente (T23)**: la cifra total se cierra al terminar el trabajo.

## Documentación

| Documento | Contenido |
|---|---|
| [`docs/spec.md`](docs/spec.md) | Especificación: reglas, decisiones con su justificación, API y códigos, estados, casos borde, supuestos |
| [`docs/plan.md`](docs/plan.md) | Plan técnico: módulos, flujo paso a paso, estrategia de concurrencia, matriz de pruebas |
| [`docs/tasks.md`](docs/tasks.md) | Tareas con su criterio de terminado y estimado |
| [`docs/pruebas_manuales.md`](docs/pruebas_manuales.md) | Guía paso a paso para probar a mano los diez escenarios |
| [`docs/ia_y_tiempo.md`](docs/ia_y_tiempo.md) | Registro del uso de IA y del tiempo |
| [`docs/diagram.mmd`](docs/diagram.mmd), [`docs/diagram-exchange-flow.mmd`](docs/diagram-exchange-flow.mmd), [`docs/diagram-er.mmd`](docs/diagram-er.mmd) | Diagramas en Mermaid (con sus imágenes en `docs/img/`) |
