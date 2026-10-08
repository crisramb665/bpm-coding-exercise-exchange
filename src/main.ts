import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { setupSwagger } from "./common/swagger/setup-swagger";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  setupSwagger(app); // Swagger UI en /docs
  app.enableShutdownHooks(); // al recibir SIGTERM/SIGINT cierra el pool de la base antes de salir
  const port = Number(process.env.PORT ?? 3000); // Es un puerto, no un monto: aquí Number es correcto.
  await app.listen(port);

  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Swagger UI available at: http://localhost:${port}/docs`);
}

void bootstrap();
