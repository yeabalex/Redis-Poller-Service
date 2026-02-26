import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { WsAdapter } from '@nestjs/platform-ws';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error', 'debug', 'verbose'],
  });

  // Use the NestJS WebSocket adapter backed by 'ws' (lightweight, no socket.io).
  app.useWebSocketAdapter(new WsAdapter(app));

  const configService = app.get(ConfigService);

  // Lock CORS to CORS_ORIGIN in prod; defaults to '*' for local dev.
  const corsOrigin = configService.get<string>('CORS_ORIGIN', '*');
  app.enableCors({ origin: corsOrigin });

  const port = configService.get<number>('PORT', 3000);
  await app.listen(port);
  console.log(`HTTP + WebSocket server listening on port ${port} (WS path: /ws)`);
}

bootstrap();
