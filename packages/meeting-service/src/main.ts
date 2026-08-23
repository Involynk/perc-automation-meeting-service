import { NestFactory } from '@nestjs/core';
import { MeetingServiceModule } from './meeting-service.module';

async function bootstrap() {
  const app = await NestFactory.create(MeetingServiceModule);
  app.enableCors();
  const port = process.env.PORT || 3004;
  await app.listen(port);
  console.log(`🚀 Meeting Service running on port ${port}`);
}
bootstrap();
