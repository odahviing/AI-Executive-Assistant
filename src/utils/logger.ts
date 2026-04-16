import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

const logPath = process.env.LOG_PATH || './logs';
if (!fs.existsSync(logPath)) fs.mkdirSync(logPath, { recursive: true });

const logger = winston.createLogger({
  // Verbosity intentionally kept at 'debug'/'info' — the log volume is how we
  // diagnose coord/MPIM/Hebrew-flow bugs after the fact. Rotation (below)
  // handles the disk-size problem without sacrificing signal.
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'maelle' },
  transports: [
    // Structured JSON to file — full audit trail, rotated daily, 7-day retention.
    // Files: maelle-YYYY-MM-DD.log. Nothing operational lives here (meetings
    // are in Graph calendar + tasks table, people in people_memory, coord
    // state in coord_jobs, audit trail in audit_log). Safe to prune at 7d.
    new DailyRotateFile({
      filename: path.join(logPath, 'maelle-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '7d',
      zippedArchive: false,
    }),
    // Error-only log — also rotated daily, kept longer (30d) for postmortems.
    new DailyRotateFile({
      filename: path.join(logPath, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      level: 'error',
      zippedArchive: false,
    }),
    // Human-readable in dev
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
          // Format timestamp as "09 Apr 22:56:58" — readable, no T/Z/milliseconds
          const ts = new Date(timestamp as string);
          const day = ts.getDate().toString().padStart(2, '0');
          const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][ts.getMonth()];
          const hh  = ts.getHours().toString().padStart(2, '0');
          const mm  = ts.getMinutes().toString().padStart(2, '0');
          const ss  = ts.getSeconds().toString().padStart(2, '0');
          const readableTs = `${day} ${mon} ${hh}:${mm}:${ss}`;

          // Also format any ISO date strings inside meta values
          const cleanMeta = JSON.parse(JSON.stringify(meta, (_k, v) => {
            if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
              const d = new Date(v);
              const dd = d.getDate().toString().padStart(2, '0');
              const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
              const h  = d.getHours().toString().padStart(2, '0');
              const m  = d.getMinutes().toString().padStart(2, '0');
              const s  = d.getSeconds().toString().padStart(2, '0');
              return `${dd} ${mo} ${h}:${m}:${s}`;
            }
            return v;
          }));

          // Use a custom serializer to preserve Unicode (Hebrew, etc.) without escaping
          const metaStr = Object.keys(cleanMeta).length
            ? '\n  ' + JSON.stringify(cleanMeta, null, 4)
                .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
                .replace(/\n/g, ' ')
            : '';
          return `${readableTs} [${level}] ${message}${metaStr}`;
        })
      ),
    }),
  ],
});

export default logger;
