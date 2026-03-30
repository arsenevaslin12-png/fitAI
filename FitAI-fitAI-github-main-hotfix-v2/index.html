"use strict";
// lib/logger.js — Structured logging for production

const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const levels = { error: 0, warn: 1, info: 2, debug: 3 };

function log(level, message, meta = {}) {
  if (levels[level] > levels[LOG_LEVEL]) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
    env: process.env.VERCEL_ENV || "local",
    region: process.env.VERCEL_REGION || "unknown"
  };

  // JSON format for log aggregation
  console.log(JSON.stringify(entry));
}

module.exports = {
  error: (msg, meta) => log("error", msg, meta),
  warn: (msg, meta) => log("warn", msg, meta),
  info: (msg, meta) => log("info", msg, meta),
  debug: (msg, meta) => log("debug", msg, meta)
};
