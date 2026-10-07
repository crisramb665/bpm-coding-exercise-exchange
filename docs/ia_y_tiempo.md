# Uso de IA y tiempo por fase

Herramienta: **Claude Code** (modelo Claude Opus 5.5), en la terminal y en modo de planificación para las fases de
documentación.

Criterio: la IA propone y redacta, y el autor revisa, decide y aprueba. Todas las decisiones de diseño están en
`docs/spec.md` con su justificación. Los tiempos son de reloj (inicio → aprobación) e **incluyen el tiempo de
revisión y decisión del autor**.

| Fase | Inicio | Fin | Duración aprox. | Qué hizo la IA | Qué decidió / revisó el autor |
| --- | --- | --- | --- | --- | --- |
| 0. Lectura y preguntas | 2026-10-06 23:28 | 2026-10-07 01:09 | ~1 h 40 min | Leyó el enunciado y `docs/schema.sql`. Detectó que el .pdf es texto plano y que los archivos se llaman distinto. Listó 9 contradicciones o vacíos del enunciado. Revisó el esquema con espíritu crítico (bloqueantes, restricciones faltantes, redundancias, concurrencia). Hizo 16 preguntas abiertas con una recomendación cada una. | Decidió D1–D14: retención como débito/crédito en la misma wallet, estados sin CREATED, precisión y redondeos, dos transacciones, reutilización de la cotización y liberación de la clave tras una falla, conservar `compliance_decisions`, quitar los montos de `exchanges` protegiendo los de `quotes`, entre otras. |
| 1. CLAUDE.md | 2026-10-07 01:09 | 2026-10-07 01:25 | ~15 min | Redactó `CLAUDE.md` (forma de trabajo, reglas técnicas, convenciones, estructura de carpetas) y este registro. | Cambió npm por pnpm. Pidió aprobar spec, plan y tasks en una sola revisión, ejecutar todo en 3 comandos (`pnpm install`, `pnpm run up`, `pnpm test`) y usar `migrations/001_schema.sql` como única fuente de verdad del esquema. |
| 2–4. spec.md + plan.md + tasks.md + esquema | 2026-10-07 01:25 | _pendiente de aprobación_ | | Escribió `migrations/001_schema.sql` aplicando la revisión aceptada y lo validó en un postgres:16 desechable (flujos válidos, 26 casos inválidos rechazados, conciliación, TRUNCATE). Redactó `docs/spec.md` (reglas, contradicciones, D1–D16, API, estados, casos borde calculados, supuestos, 2 preguntas abiertas), `docs/plan.md` (capas, flujo de dos transacciones con sus bloqueos, concurrencia, matriz de pruebas, esquema del README) y `docs/tasks.md` (23 tareas con DoD y estimado). Actualizó `CLAUDE.md`. | _Revisión pendiente._ |
| Implementación | | | | | |
| README, diagrama, mockup y revisión | | | | | |

## Notas para el README

- Declarar la herramienta y su uso: análisis del enunciado, revisión del esquema, redacción de la spec, del plan y
  de las tareas, y (más adelante) apoyo en la implementación y las pruebas.
- Declarar que el autor tomó cada decisión de diseño y asume la responsabilidad del código entregado
  (sección 11 del enunciado).
