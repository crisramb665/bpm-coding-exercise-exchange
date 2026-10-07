import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT ?? 3000); // Es un puerto, no un monto: aquí Number es correcto.
  await app.listen(port);
}

void bootstrap();
