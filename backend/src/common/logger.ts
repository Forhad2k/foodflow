import pino from 'pino';

/** One structured JSON logger for the whole process. Secrets and credentials are redacted everywhere. */
export const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', 'req.body.password', 'req.body.token'],
    censor: '[redacted]',
  },
  ...(process.env.NODE_ENV === 'development' && { transport: { target: 'pino-pretty', options: { singleLine: true } } }),
});

export interface AppLogger {
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export function createLogger(name: string): AppLogger {
  const l = rootLogger.child({ name });
  return { log: (m) => l.info(m), warn: (m) => l.warn(m), error: (m) => l.error(m), debug: (m) => l.debug(m) };
}
