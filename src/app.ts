import Fastify, { FastifyInstance } from 'fastify';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: true
  });

  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'file-relay-hub'
    };
  });

  return app;
}
