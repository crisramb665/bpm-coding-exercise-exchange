# CLAUDE.md

Prueba técnica de backend: intercambio USDT-SBX → XAUT-SBX con wallets internas, ledger, cotizaciones,
un servicio simulado de cumplimiento e idempotencia. El enunciado está en `docs/prueba_tecnica.pdf` (es texto plano);
la fuente de verdad funcional es `docs/spec.md` y la técnica `docs/plan.md`.

## Forma de trabajo

- Desarrollo guiado por especificación. Primero la spec, luego el plan, luego las tareas y al final el código.
  `spec.md`, `plan.md` y `tasks.md` se aprueban juntos en una sola revisión. En las demás fases hay que detenerse
  al terminar y esperar la aprobación.
- Nada se decide en silencio. Si algo es ambiguo o contradictorio, se anota como pregunta abierta y se pregunta.
  Las decisiones tomadas quedan en `docs/spec.md` con su justificación.
- El autor debe poder explicar y modificar cualquier línea en vivo. Se prefiere código simple y explícito antes que
  abstracciones ingeniosas, y se comenta el **porqué** de toda decisión no obvia (bloqueos, redondeos, orden de pasos).
- Hay que respetar la sección 7 del enunciado (fuera de alcance). Ante la duda, gana la opción más simple que
  preserve la integridad.
- Cada fase se registra en `docs/ia_y_tiempo.md`: qué hizo la IA, qué decidió el autor y cuánto tiempo tomó.

## Reglas técnicas obligatorias

1. **Node.js + TypeScript + NestJS**, con `strict: true`. Módulos planos; nada de interceptores ni decoradores
   propios si no hacen falta.
2. **PostgreSQL 16 con `pg` y SQL directo, sin ORM.** Las consultas siempre van parametrizadas (`$1`) y nunca se
   construyen concatenando strings. Las migraciones son archivos `migrations/NNN_descripcion.sql`, que
   `scripts/migrate.ts` aplica en orden y registra en `schema_migrations`. **`migrations/001_schema.sql` es la
   única fuente de verdad del esquema**: no existe una copia en `docs/`. Cualquier cambio posterior va en una
   migración nueva (`003_…`) y nunca editando una que ya se aplicó.
3. **Montos con `decimal.js`, nunca `Number` ni `parseFloat`.** Las columnas `numeric` llegan de `pg` como string:
   se convierten con `new Decimal(str)` y se vuelven a enviar como string (`toFixed(8)`). En el JSON de la API los
   montos también viajan como string.
4. **Las pruebas usan un PostgreSQL real en Docker**, sin simular la base. El único doble permitido es el servicio
   de cumplimiento, que el enunciado pide simular y que se inyecta como provider.
5. **Simplicidad antes que completitud**, porque el tiempo es corto.

## Convenciones

- Los identificadores del código van en inglés; los comentarios y la documentación, en español.
- Los errores de negocio tienen un código estable (`QUOTE_EXPIRED`, `INSUFFICIENT_FUNDS`,
  `IDEMPOTENCY_KEY_MISMATCH`…) y un status HTTP definido en `docs/spec.md`.
- Las transacciones son explícitas (`BEGIN`/`COMMIT`/`ROLLBACK`) con un cliente obtenido del pool. Nunca se llama
  a servicios externos con una transacción abierta.
- Los bloqueos (`SELECT … FOR UPDATE`) siempre se toman en el mismo orden para evitar interbloqueos:
  exchange → quote → wallets (las wallets ordenadas por `id`).
- Los saldos (`available`, `held`) solo cambian en la misma transacción que inserta el movimiento de ledger
  correspondiente. Los movimientos, los checks de cumplimiento, las decisiones y los eventos no se actualizan ni
  se borran; un trigger lo impide.
- Para el tiempo de negocio (vigencia de cotizaciones) se usa la hora de la base (`now()`), no la del proceso Node.

## Estructura de carpetas propuesta

```
src/
  main.ts, app.module.ts
  common/
    db/          # Pool de pg como provider + helper withTransaction
    auth/        # guard X-User-Id (401) y guard de rol (403)
    errors/      # BusinessError + filtro que lo traduce a HTTP
    money/       # cálculo de cotización con decimal.js (funciones puras)
    http/        # utilidades de los endpoints (parseLimit)
    swagger/     # Swagger UI en /docs: configuración, decorador de errores y ejemplos de respuesta
  wallets/       # GET /wallets, GET /wallets/:id/movements
  quotes/        # POST /quotes
  exchanges/     # POST /exchanges, GET /exchanges, GET /exchanges/:id, idempotencia, ledger
  compliance-service/  # servicio AUTOMÁTICO de monitoreo (R10): contrato, mock y cliente. Responde LOW/MEDIUM/HIGH
  compliance-review/   # revisión HUMANA (rol COMPLIANCE): endpoints /compliance/* para aprobar o rechazar (T14)
migrations/      # 001_schema.sql (fuente de verdad del esquema), 002_seed.sql, ...
scripts/         # migrate.ts
test/            # pruebas e2e con supertest contra Postgres en Docker
docs/            # prueba_tecnica.pdf, spec.md, plan.md, tasks.md, diagram.mmd, ia_y_tiempo.md
docker-compose.yml
```

Cada módulo tiene `*.controller.ts` (HTTP y validación), `*.service.ts` (reglas y transacciones) y, si hace falta,
`*.repository.ts` (SQL). No se agregan más capas.

## Comandos

El README promete como máximo tres comandos, y los pasos intermedios se agrupan en scripts de `package.json`:

1. `pnpm install`: instala las dependencias.
2. `pnpm run up`: levanta Postgres (`docker compose up -d --wait`), aplica las migraciones y la semilla, e inicia la API.
3. `pnpm test`: levanta Postgres si no está arriba, recrea la base de pruebas `exchange_test`, la migra y corre Jest.

Scripts auxiliares, que no hace falta usar a mano: `pnpm run db:up`, `pnpm run migrate` y `pnpm run start`.
