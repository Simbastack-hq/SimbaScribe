import { pino } from 'pino';

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'simbascribe' },
});

export type Logger = typeof log;
