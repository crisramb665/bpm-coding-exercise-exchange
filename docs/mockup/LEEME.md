# Mockup de baja fidelidad

Entrega de la sección 8 del enunciado: la experiencia mínima del **Usuario** y de **Cumplimiento**, en cuatro pantallas.

| Pantalla | Archivo | Qué muestra |
|---|---|---|
| 1. Panel del usuario | `1-panel-usuario.png` | Wallets USDT-SBX y XAUT-SBX con disponible, retenido y total; últimos movimientos; acceso a «Solicitar intercambio»; mis operaciones |
| 2. Solicitud de intercambio | `2-solicitud-intercambio.png` | Monto, precio, comisión, XAUT estimado, vigencia de 30 s, botón de confirmar y mensajes de validación |
| 3. Resultado de la operación | `3-resultado-operacion.png` | Completada (LOW y MEDIUM), pendiente de revisión, rechazada, cotización vencida, saldo insuficiente, falla del servicio de cumplimiento y reintento |
| 4. Bandeja de Cumplimiento | `4-bandeja-cumplimiento.png` | Operaciones retenidas (usuario, monto, activo, riesgo, fecha), aprobar y rechazar (motivo obligatorio), otro revisor ya decidió, bandeja vacía |

- **`mockup.pdf`**: las cuatro pantallas, una por página. Es el archivo para leer de corrido.
- **`mockup.html`**: la fuente. Es un wireframe en escala de grises, sin identidad visual; no es una aplicación ni se conecta a la API.

## Cómo se conecta con el backend

Cada pantalla indica en gris el endpoint que la alimenta, y cada estado o error del dibujo corresponde a uno real del sistema. Una prueba
(`test/e2e/mockup.e2e-spec.ts`) lo verifica contra la API y la base de datos reales: los endpoints que nombra el mockup son exactamente
los 9 de la API, sus estados existen en el `CHECK` del esquema, sus códigos de error están documentados en Swagger, no omite ningún
error que un usuario pueda ver al cotizar o ejecutar, y sus cifras coinciden con `calculateQuote`.

## Regenerar las imágenes y el PDF

Si se edita `mockup.html`: abrirlo en un navegador basado en Chromium e **Imprimir → Guardar como PDF** (el tamaño de página ya está en el
CSS: una pantalla por página). Para los PNG, capturar cada `<section class="screen">` (en las herramientas del navegador:
*Capture node screenshot*). Se generaron con `puppeteer-core` y Brave en una escala de 1,5.
