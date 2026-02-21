import { existsSync } from 'node:fs';
import path from 'node:path';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import fastifyStatic from '@fastify/static';
import { AppModule } from './app.module';

function resolveMonitorStaticRoot(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'public', 'monitor'),
    path.resolve(process.cwd(), 'services', 'api', 'public', 'monitor'),
  ];

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'index.html'))) {
      return candidate;
    }
  }

  return candidates[0];
}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  app.setGlobalPrefix('v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidUnknownValues: false,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('OMX Web Orchestrator API')
    .setDescription('MVP API for queued OMX/OMC-style jobs')
    .setVersion('0.1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('/docs', app, document);

  await app.register(fastifyStatic, {
    root: resolveMonitorStaticRoot(),
    prefix: '/monitor/',
    index: ['index.html'],
  });

  const port = Number(process.env.PORT ?? 8080);
  await app.listen(port, '0.0.0.0');

  Logger.log(`API listening on http://localhost:${port}`);
}

bootstrap();
