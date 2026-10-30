import 'dotenv/config'; // load backend/.env for local development (a no-op when real environment variables are provided)
import { validateEnv } from './config/env';
import { createContainer } from './container';
import { createServer } from 'http';
import { createApp } from './http/app';
import { RealtimeGateway } from './realtime/gateway';
import { startJobs } from './jobs';
import { rootLogger } from './common/logger';
import { PrismaService } from './prisma/prisma.service';

async function main() {
  const env = validateEnv(process.env); // fails fast on bad configuration
  const prisma = new PrismaService();
  await prisma.$connect();
  const container = createContainer({ prisma, env });
  const app = createApp(container);
  const stopJobs = startJobs(container);

  const server = createServer(app);
  const gateway = new RealtimeGateway(container, server);
  await container.fanout.start();
  const sweep = setInterval(() => void gateway.tick().catch(() => undefined), 3_000); // end finished tracking rooms, flag silent riders
  sweep.unref();
  server.listen(env.PORT, () => rootLogger.info(`FoodFlow API + realtime listening on :${env.PORT}`));

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    rootLogger.info(`${signal} received: shutting down`);
    stopJobs();
    clearInterval(sweep);
    void container.fanout.stop();
    void gateway.close();
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref(); // never hang on a stuck connection
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  rootLogger.fatal(err);
  process.exit(1);
});
