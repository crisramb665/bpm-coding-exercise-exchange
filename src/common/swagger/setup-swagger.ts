import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

// Documentación navegable de la API (Swagger UI en /docs y el JSON en /docs-json). Se monta aparte, en main.ts: las pruebas
// crean la app desde AppModule y la montan por su cuenta cuando quieren verificar el documento (swagger.e2e-spec.ts).
// Las rutas de Swagger las registra el adaptador HTTP, no un controller de Nest, así que los guards globales (401/403) no
// las alcanzan: /docs se abre sin X-User-Id.
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Intercambio USDT-SBX → XAUT-SBX')
    .setDescription(
      [
        'API del núcleo de una plataforma de activos digitales con wallets internas: cotización, intercambio con control ',
        'transaccional e idempotencia, y revisión de Cumplimiento para las operaciones de riesgo alto.',
        '',
        '**Autenticación simplificada.** Todas las rutas se identifican con el encabezado `X-User-Id` (botón *Authorize*). ',
        'Usuarios de la semilla: `user-001` (rol USER, 10.000 USDT-SBX) y `compliance-001` (rol COMPLIANCE). ',
        'Sin el encabezado, o con un usuario que no existe: **401**. Con un rol sin permiso para la ruta: **403**.',
        '',
        '**Montos.** Siempre son *strings* con hasta 8 decimales (`"2500.00000000"`), nunca números JSON: así no se pierde precisión. ',
        'Un número JSON en un monto es un 400.',
        '',
        '**Flujo.** `POST /quotes` (vigencia de 30 s) → `POST /exchanges` con `Idempotency-Key`. Según el monto, el servicio de ',
        'cumplimiento responde LOW (< 1.000: se ejecuta), MEDIUM (1.000 a 5.000: se ejecuta y queda marcada para seguimiento) o ',
        'HIGH (> 5.000: queda retenida, `PENDING_REVIEW`, hasta que Cumplimiento la apruebe o rechace).',
        '',
        '**Errores.** Siempre con la forma `{ "error": { "code", "message", "details"? } }` y un `code` estable.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addApiKey(
      { type: 'apiKey', name: 'X-User-Id', in: 'header', description: 'Identificador del usuario: `user-001` o `compliance-001`.' },
      'X-User-Id',
    )
    .build();

  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config), {
    swaggerOptions: { persistAuthorization: true }, // el usuario elegido sobrevive a recargar la página
  });
}
