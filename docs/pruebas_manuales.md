# Guía de pruebas manuales

Recorrido paso a paso por la API con `curl`, para comprobar a mano los diez escenarios del enunciado (a–j) y los casos
borde principales. Las pruebas automatizadas (`pnpm test`) cubren lo mismo y más; esta guía sirve para **ver** el sistema
funcionando, por ejemplo en la sustentación.

Cada bloque de código se ejecutó contra el servidor real antes de escribir esta guía; los resultados que se muestran son los
que salieron.

## 0. Preparación

Necesitas Docker, Node 22, pnpm y `jq` (`brew install jq` si no lo tienes). Abre **dos terminales** en la carpeta del proyecto.

**Terminal 1 — el servidor.** Para partir de cero (borra los datos de desarrollo):

```text
docker compose down -v
pnpm install
pnpm run up
```

Déjala corriendo; verás `Nest application successfully started`.

**Terminal 2 — los comandos.** Pega este bloque una sola vez: define unas funciones cortas para no repetir `curl`.

```bash
export BASE=http://localhost:3000

# req MÉTODO RUTA USUARIO [JSON] [CLAVE-DE-IDEMPOTENCIA]
# Hace la petición, guarda la respuesta en /tmp/b.json, y muestra el código HTTP (y si la respuesta fue reproducida).
req() {
  local extra=()
  [ -n "$4" ] && extra+=(-d "$4")
  [ -n "$5" ] && extra+=(-H "Idempotency-Key: $5")
  curl -s -D /tmp/h.txt -o /tmp/b.json -w 'HTTP %{http_code}\n' -X "$1" "$BASE$2" \
       -H 'Content-Type: application/json' -H "X-User-Id: $3" "${extra[@]}"
  grep -i '^idempotent-replayed' /tmp/h.txt
}

# cotizar MONTO  →  imprime el id de la cotización (de user-001)
cotizar() {
  req POST /quotes user-001 "{\"source_asset\":\"USDT-SBX\",\"target_asset\":\"XAUT-SBX\",\"source_amount\":\"$1\"}" > /dev/null
  jq -r '.id' /tmp/b.json
}

# saldos [USUARIO]  →  muestra disponible, retenido y total de cada wallet
saldos() { req GET /wallets "${1:-user-001}" > /dev/null; jq -c '.[] | {asset, available, held, total}' /tmp/b.json; }

# resumen  →  muestra lo importante de la última respuesta de una operación
resumen() {
  jq '{status, risk_level, requires_follow_up, failure_reason,
       movimientos: [.movements[] | "\(.asset) \(.entry_type) \(.balance_type) \(.amount)  (\(.balance_before) -> \(.balance_after))"],
       eventos: [.events[] | "\(.from_status // "-") -> \(.to_status) [\(.actor_id // "sistema")]"]}' /tmp/b.json
}
```

> **Ojo:** cada llamada a `req` (y a `saldos`, `cotizar`) **sobrescribe** `/tmp/b.json`. Si necesitas un dato de una respuesta (un `id`), guárdalo en una
> variable *justo después* de la petición, antes de llamar a `resumen` o `saldos`, como hacen los pasos de abajo.

Usuarios de la semilla: `user-001` (rol USER, 10.000 USDT-SBX) y `compliance-001` (rol COMPLIANCE, sin saldo). Se identifican con el
encabezado `X-User-Id`.

## Alternativa visual: Swagger UI

Con el servidor corriendo, la API se puede probar sin `curl` desde el navegador, en **http://localhost:3000/docs**. Muestra las 9 rutas
agrupadas (*Wallets*, *Cotizaciones*, *Intercambios*, *Cumplimiento*), con su descripción, los códigos de respuesta posibles y ejemplos.

1. Pulsa **Authorize**, escribe `user-001` como valor de `X-User-Id` y cierra el diálogo. Desde ahí todas las peticiones salen como ese usuario
   (para actuar como Cumplimiento, vuelve a *Authorize* y usa `compliance-001`).
2. Abre `POST /quotes` → **Try it out**. Deja el cuerpo de ejemplo (`"source_amount": "2500"`) → **Execute**. Copia el `id` de la respuesta.
3. Abre `POST /exchanges` → **Try it out**. En `Idempotency-Key` escribe `demo-1` y en el cuerpo pega `{"quote_id": "<el id copiado>"}` → **Execute**.
   Responde `201` con `COMPLETED`. Pulsa **Execute** otra vez con la misma clave: devuelve lo mismo, y en los encabezados aparece `idempotent-replayed: true`.
4. Abre `GET /wallets` → **Execute** para ver los saldos, y `GET /exchanges/{id}` con el id de la operación para ver toda la trazabilidad.

El resto de esta guía usa `curl` porque permite recorrer los diez escenarios en orden y comprobar los resultados exactos.

## 1. Estado inicial y autenticación

```bash
saldos
```

Esperado: `USDT-SBX` con `available 10000.00000000`, `held 0`, `total 10000.00000000`, y `XAUT-SBX` en cero.

**401:** sin el encabezado, o con un usuario que no existe.

```bash
curl -s -w '\nHTTP %{http_code}\n' "$BASE/wallets"
curl -s -w '\nHTTP %{http_code}\n' "$BASE/wallets" -H 'X-User-Id: fantasma'
```

Esperado: `HTTP 401` y `"code": "UNAUTHENTICATED"` en ambos.

## 2. Escenario a — LOW se ejecuta automáticamente (999,99 USDT)

```bash
Q_LOW=$(cotizar 999.99)
jq '{source_amount, price, fee_amount, net_amount, target_amount, status, expires_at}' /tmp/b.json
req POST /exchanges user-001 "{\"quote_id\":\"$Q_LOW\"}" k-low
resumen
saldos
```

Esperado:
- La cotización: comisión `9.99990000`, neto `989.99010000`, `target_amount 0.39599604`, `status ACTIVE`.
- `HTTP 201`, `status COMPLETED`, `risk_level LOW`, `requires_follow_up false`.
- Dos movimientos: `USDT-SBX DEBIT AVAILABLE 999.99` y `XAUT-SBX CREDIT AVAILABLE 0.39599604`.
- Saldos: USDT `9000.01`, XAUT `0.39599604`.

## 3. Escenario b — MEDIUM se ejecuta y queda marcada para seguimiento (2.500 USDT)

```bash
Q_MED=$(cotizar 2500)
req POST /exchanges user-001 "{\"quote_id\":\"$Q_MED\"}" k-medium
resumen
saldos
```

Esperado: `HTTP 201`, `COMPLETED`, `risk_level MEDIUM`, **`requires_follow_up true`**, 0,99 XAUT (es el ejemplo del enunciado).
Saldos: USDT `6500.01`, XAUT `1.38599604`.

## 4. Escenario g — HIGH queda retenida (5.000,01 USDT)

```bash
Q_HIGH1=$(cotizar 5000.01)
req POST /exchanges user-001 "{\"quote_id\":\"$Q_HIGH1\"}" k-high1
HIGH1=$(jq -r '.id' /tmp/b.json)   # se guarda ANTES de llamar a otra función: /tmp/b.json se sobrescribe en cada llamada
resumen
saldos
```

Esperado: `HTTP 201`, **`PENDING_REVIEW`**, `risk_level HIGH`. Movimientos: `DEBIT AVAILABLE 5000.01` y `CREDIT HELD 5000.01`
(no hay crédito de XAUT). Saldos: USDT `available 1500.00`, **`held 5000.01`**, `total 6500.01`; el XAUT no cambia.

## 5. La bandeja de Cumplimiento y el escenario j — un USER no puede aprobar

```bash
req GET /compliance/exchanges/pending compliance-001
jq '.[] | {id, user_name, source_amount, target_amount, price, risk_level, created_at}' /tmp/b.json
```

Esperado: `HTTP 200` con una operación: la de 5.000,01 USDT de `user-001`, precio `2500.00000000`.

**j — segregación de funciones.** El usuario normal no puede ver la bandeja, aprobar ni rechazar; y Cumplimiento no puede cotizar.

```bash
req GET /compliance/exchanges/pending user-001
req PATCH "/compliance/exchanges/$HIGH1/approve" user-001 '{}'
req PATCH "/compliance/exchanges/$HIGH1/reject" user-001 '{"reason":"intento"}'
req POST /quotes compliance-001 '{"source_asset":"USDT-SBX","target_asset":"XAUT-SBX","source_amount":"100"}'
jq -r '.error.code' /tmp/b.json
```

Esperado: cuatro veces `HTTP 403` con `FORBIDDEN`. La operación sigue retenida (compruébalo con `saldos`: `held 5000.01`).

## 6. Escenario i — rechazar y liberar el saldo

```bash
req PATCH "/compliance/exchanges/$HIGH1/reject" compliance-001 '{"reason":"Origen de fondos no acreditado"}'
resumen
saldos
```

Esperado: `HTTP 200`, **`REJECTED`**. Cuatro movimientos: la retención y su liberación (`DEBIT HELD` + `CREDIT AVAILABLE`). El último evento
es `PENDING_REVIEW -> REJECTED [compliance-001]`. Saldos: USDT **`available 6500.01`, `held 0`** (liberado); el XAUT no cambia.

La cotización de una operación rechazada no se reutiliza (D4):

```bash
req POST /exchanges user-001 "{\"quote_id\":\"$Q_HIGH1\"}" k-high1-reintento
jq -r '.error.code' /tmp/b.json
```

Esperado: `HTTP 409`, `QUOTE_ALREADY_USED`.

## 7. Escenario h — aprobar una operación retenida

Se retiene otra vez (el saldo liberado lo permite) y esta vez se **aprueba**.

```bash
Q_HIGH2=$(cotizar 5000.01)
req POST /exchanges user-001 "{\"quote_id\":\"$Q_HIGH2\"}" k-high2
HIGH2=$(jq -r '.id' /tmp/b.json)
req PATCH "/compliance/exchanges/$HIGH2/approve" compliance-001 '{"reason":"Origen de fondos verificado"}'
resumen
saldos
```

Esperado: `HTTP 201` (queda retenida) y luego `HTTP 200` con **`COMPLETED`**. Movimientos: la retención, `DEBIT HELD 5000.01`
y `XAUT-SBX CREDIT AVAILABLE 1.98000396`. Saldos: USDT `available 1500.00`, `held 0`; XAUT **`3.36600000`**
(0,39599604 + 0,99 + 1,98000396).

Cumplimiento tiene wallets (D17) pero la decisión **nunca las toca**:

```bash
saldos compliance-001
```

Esperado: todo en `0.00000000`.

**Doble decisión:** aprobar de nuevo la misma operación.

```bash
req PATCH "/compliance/exchanges/$HIGH2/approve" compliance-001 '{}'
jq '.error | {code, details}' /tmp/b.json
```

Esperado: `HTTP 409`, `EXCHANGE_NOT_PENDING` con `"status": "COMPLETED"`.

**Rechazar exige motivo:**

```bash
req PATCH "/compliance/exchanges/$HIGH2/reject" compliance-001 '{}'
```

Esperado: `HTTP 400` (`VALIDATION_ERROR`). (Con motivo respondería 409 porque ya está decidida.)

## 8. Escenario c — saldo insuficiente

Quedan 1.500 USDT disponibles.

```bash
Q_GRANDE=$(cotizar 2000)
req POST /exchanges user-001 "{\"quote_id\":\"$Q_GRANDE\"}" k-grande
jq '.error | {code, details}' /tmp/b.json
saldos
```

Esperado: `HTTP 422`, `INSUFFICIENT_FUNDS` con `available 1500.00000000` y `required 2000.00000000`. Los saldos no cambian. La cotización
sigue disponible (no se consumió).

## 9. Escenario d — cotización vencida

La vigencia es de 30 segundos. Cotiza, espera y ejecuta:

```bash
Q_VENCE=$(cotizar 100)
sleep 31
req POST /exchanges user-001 "{\"quote_id\":\"$Q_VENCE\"}" k-vence
jq '.error | {code, message}' /tmp/b.json
```

Esperado: `HTTP 422`, `QUOTE_EXPIRED`. Sin movimientos.

## 10. Escenarios e y f — idempotencia

**e — misma clave, mismo contenido:** devuelve la respuesta original, sin duplicar movimientos.

```bash
req POST /exchanges user-001 "{\"quote_id\":\"$Q_LOW\"}" k-low
jq '{id, status}' /tmp/b.json
saldos
```

Esperado: `HTTP 201`, **`Idempotent-Replayed: true`**, el mismo `id` de la operación del paso 2, y los saldos sin cambio.

**f — misma clave, contenido distinto:**

```bash
Q_OTRA=$(cotizar 50)
req POST /exchanges user-001 "{\"quote_id\":\"$Q_OTRA\"}" k-low
jq -r '.error.code' /tmp/b.json
```

Esperado: `HTTP 409`, `IDEMPOTENCY_KEY_MISMATCH`.

**Cotización ya usada, con otra clave:**

```bash
req POST /exchanges user-001 "{\"quote_id\":\"$Q_LOW\"}" k-otra-clave
jq -r '.error.code' /tmp/b.json
```

Esperado: `HTTP 409`, `QUOTE_ALREADY_USED`.

**Sin la clave de idempotencia:**

```bash
req POST /exchanges user-001 "{\"quote_id\":\"$Q_OTRA\"}"
jq -r '.error.details.fields[0].field' /tmp/b.json
```

Esperado: `HTTP 400`, campo `Idempotency-Key`.

## 11. El servicio de cumplimiento falla (R12)

Se simula con la variable `COMPLIANCE_MOCK_FAIL`. **En la Terminal 1**, detén el servidor (`Ctrl+C`) y arráncalo así:

```bash restart-fail
COMPLIANCE_MOCK_FAIL=true pnpm run start
```

**En la Terminal 2:**

```bash
Q_FALLA=$(cotizar 100)
req POST /exchanges user-001 "{\"quote_id\":\"$Q_FALLA\"}" k-falla
FALLIDA=$(jq -r '.error.details.exchange_id' /tmp/b.json)
jq '.error | {code, details}' /tmp/b.json
saldos
```

Esperado: `HTTP 503`, `COMPLIANCE_UNAVAILABLE` con el `exchange_id` de la operación. **Los saldos no cambian** (USDT `1500.00`).

La operación quedó en estado controlado (FAILED), con la consulta fallida registrada:

```bash
req GET "/exchanges/$FALLIDA" user-001
resumen
jq '.compliance_checks[] | {outcome, error_message}' /tmp/b.json
```

Esperado: `FAILED`, `failure_reason COMPLIANCE_UNAVAILABLE`, sin movimientos, y una consulta con `outcome ERROR`.

Ahora **en la Terminal 1** reinicia el servidor normal (`Ctrl+C` y `pnpm run start`) y reintenta con **la misma clave**:

```bash restart-ok
pnpm run start
```

```bash
req POST /exchanges user-001 "{\"quote_id\":\"$Q_FALLA\"}" k-falla
resumen
saldos
```

Esperado: `HTTP 201` (no se reproduce el 503: la clave se había liberado), `COMPLETED`, `LOW`. Saldos: USDT `1400.00`.

## 12. Consultas

```bash
req GET /exchanges user-001
jq -c '.[] | {status, risk_level, source_amount, target_amount}' /tmp/b.json
```

Esperado: las operaciones de `user-001`, **la más reciente primero**. Un usuario solo ve las suyas; con `?userId=` de otro:

```bash
req GET "/exchanges?userId=compliance-001" user-001
jq -r '.error.code' /tmp/b.json
req GET "/exchanges?userId=user-001&limit=2" compliance-001
jq 'length' /tmp/b.json
```

Esperado: `HTTP 403` (`FORBIDDEN`) y luego `HTTP 200` con `2` (Cumplimiento sí puede filtrar por usuario).

**Detalle y trazabilidad de una operación**, visto por Cumplimiento:

```bash
req GET "/exchanges/$HIGH2" compliance-001
jq '{status, quote: (.quote | {price, fee_amount, target_amount}), decision, checks: [.compliance_checks[] | {provider, outcome, risk_level}]}' /tmp/b.json
resumen
```

Esperado: `COMPLETED`, el precio y la comisión **originales** de la cotización, la `decision` (`APPROVED` por `compliance-001`), la consulta
a cumplimiento y los eventos, con quién hizo cada transición.

**Movimientos de una wallet** (del más reciente al más antiguo):

```bash
req GET /wallets user-001
W_USDT=$(jq -r '.[] | select(.asset=="USDT-SBX") | .id' /tmp/b.json)
req GET "/wallets/$W_USDT/movements?limit=5" user-001
jq -c '.[] | {entry_type, balance_type, amount, balance_before, balance_after, reference_type}' /tmp/b.json
```

Una wallet ajena da 404 sin revelar si existe:

```bash
req GET "/wallets/$W_USDT/movements" compliance-001
jq -r '.error.code' /tmp/b.json
```

Esperado: `HTTP 404`, `WALLET_NOT_FOUND`.

## 13. Integridad en la base de datos

Los saldos solo cambian mediante movimientos del ledger, y estos no se pueden modificar. Se comprueba directamente en PostgreSQL.

**Conciliación:** el saldo de cada wallet debe ser igual a la suma de sus movimientos (créditos menos débitos).

```bash
docker compose exec -T db psql -U exchange -d exchange -c "
SELECT w.user_id, w.asset_code, w.available, w.held,
       COALESCE(SUM(CASE WHEN l.balance_type='AVAILABLE' THEN CASE l.entry_type WHEN 'CREDIT' THEN l.amount ELSE -l.amount END END),0) AS ledger_available,
       COALESCE(SUM(CASE WHEN l.balance_type='HELD'      THEN CASE l.entry_type WHEN 'CREDIT' THEN l.amount ELSE -l.amount END END),0) AS ledger_held
  FROM wallets w LEFT JOIN ledger_entries l ON l.wallet_id = w.id
 GROUP BY w.id ORDER BY w.user_id, w.asset_code;"
```

Esperado: en cada fila, `available = ledger_available` y `held = ledger_held`.

**Los movimientos son inmutables** (cada uno debe fallar):

```bash
docker compose exec -T db psql -U exchange -d exchange -c "UPDATE ledger_entries SET amount = 1;" 2>&1 | grep -i "append-only"
docker compose exec -T db psql -U exchange -d exchange -c "DELETE FROM ledger_entries;" 2>&1 | grep -i "append-only"
```

Esperado: `ERROR: UPDATE on ledger_entries is not allowed: table is append-only` (y lo mismo para `DELETE`).

**Los saldos nunca son negativos:**

```bash
docker compose exec -T db psql -U exchange -d exchange -c "UPDATE wallets SET available = -1 WHERE asset_code = 'USDT-SBX';" 2>&1 | grep -i "wallets_available_check"
```

Esperado: `violates check constraint "wallets_available_check"`.

## 14. Resumen: qué escenario prueba cada paso

| Escenario del enunciado | Paso | Resultado esperado |
|---|---|---|
| a. LOW exitoso | 2 | 201, `COMPLETED`, sin seguimiento |
| b. MEDIUM con seguimiento | 3 | 201, `COMPLETED`, `requires_follow_up true` |
| c. Saldo insuficiente | 8 | 422 `INSUFFICIENT_FUNDS` |
| d. Cotización vencida | 9 | 422 `QUOTE_EXPIRED` |
| e. Misma clave, mismo contenido | 10 | 201 reproducido (`Idempotent-Replayed: true`) |
| f. Misma clave, otro contenido | 10 | 409 `IDEMPOTENCY_KEY_MISMATCH` |
| g. HIGH retenida | 4 | 201 `PENDING_REVIEW`, saldo retenido |
| h. Aprobación | 7 | 200 `COMPLETED`, XAUT acreditado |
| i. Rechazo y liberación | 6 | 200 `REJECTED`, saldo liberado |
| j. USER sin rol de Cumplimiento | 5 | 403 `FORBIDDEN` |
| Falla del servicio de cumplimiento | 11 | 503, sin tocar saldos, reintento posible |
