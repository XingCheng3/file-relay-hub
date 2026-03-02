import { buildApp } from './app';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

const start = async () => {
  const app = await buildApp();

  try {
    await app.listen({ port, host });
    app.log.info(`server listening on http://${host}:${port}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
