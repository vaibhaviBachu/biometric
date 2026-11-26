/**
 * PINIT-DNA — Structured Logger (Winston)
 *
 * Every entry passes through the redaction format first, so tokens, cookies, Authorization values, share-link
 * tokens and secret-named fields never reach the console or any log drain (see log-redaction.ts).
 */

import winston from 'winston';
import { config } from '../config';
import { redactString, redactValue } from './log-redaction';
import { getRequestId } from './request-context';

const { combine, timestamp, colorize, printf, json } = winston.format;

/** Scrubs the message and every metadata field of a log entry. */
export const redactSecrets = winston.format((info) => {
  const { level, message, ...meta } = info as unknown as { level: string; message: unknown; [k: string]: unknown };
  const out: Record<string, unknown> = { level, message: typeof message === 'string' ? redactString(message) : redactValue(message) };
  for (const [key, value] of Object.entries(meta)) out[key] = redactValue(value, key);
  // Symbol-keyed fields (winston's own LEVEL/MESSAGE/SPLAT) must be carried over untouched.
  for (const sym of Object.getOwnPropertySymbols(info)) (out as Record<symbol, unknown>)[sym] = (info as Record<symbol, unknown>)[sym];
  return out as never;
});

/**
 * PGAP-11: injects the current request/job's correlation ID (set by
 * request-id.middleware.ts via AsyncLocalStorage) into every log entry
 * automatically, so the hundreds of existing logger.* call sites across this
 * codebase gain correlation without each one being individually touched. A
 * call made outside any request or job context (e.g. at module load) simply
 * gets no requestId field, rather than an error.
 */
const addRequestId = winston.format((info) => {
  const requestId = getRequestId();
  if (requestId && !('requestId' in info)) {
    (info as Record<string, unknown>)['requestId'] = requestId;
  }
  return info;
});

const devFormat = combine(
  addRequestId(),
  redactSecrets(),
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  printf(({ level, message, timestamp: ts, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${ts} [${level}] ${message}${metaStr}`;
  })
);

const prodFormat = combine(addRequestId(), redactSecrets(), timestamp(), json());

export const logger = winston.createLogger({
  level: config.log.level,
  format: config.env === 'production' ? prodFormat : devFormat,
  transports: [new winston.transports.Console()],
});
