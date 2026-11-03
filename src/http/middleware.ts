import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../errors.ts";

export function bearer(req: Request): string {
  const h = req.get("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}

/** Wrap an async handler so a rejected promise reaches the error handler. */
export const handle = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res).catch(next); };

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const id = req.get("x-request-id") ?? randomUUID();
  res.setHeader("x-request-id", id);
  const t0 = performance.now();
  res.on("finish", () => {
    if (process.env.NODE_ENV === "test") return;
    console.log(JSON.stringify({ level: "info", id, method: req.method, path: req.path, status: res.statusCode,
      ms: Math.round(performance.now() - t0) }));
  });
  next();
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("content-security-policy",
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; frame-ancestors 'none'");
  next();
}

/** Token bucket per client IP, in memory. Good enough for one instance; use a shared
 *  store (Redis, the database) behind a load balancer. */
export function rateLimit(perMinute: number): RequestHandler {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (req, res, next) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
    b.at = now;
    if (b.tokens < 1) {
      res.setHeader("retry-after", String(Math.ceil(((1 - b.tokens) * 60) / perMinute)));
      res.status(429).json({ error: { code: "rate_limited", message: "too many requests, try again shortly" } });
      return;
    }
    b.tokens -= 1;
    buckets.set(key, b);
    if (buckets.size > 50_000) buckets.clear();
    next();
  };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(422).json({ error: { code: "invalid", message: "invalid request", details: err.flatten() } });
    return;
  }
  const e = err as { type?: string; status?: number; message?: string };
  if (e.type === "entity.parse.failed" || e.type === "entity.too.large") {
    res.status(e.status ?? 400).json({ error: { code: "bad_request", message: e.message ?? "bad request" } });
    return;
  }
  console.error(JSON.stringify({ level: "error", msg: (err as Error).message, stack: (err as Error).stack }));
  res.status(500).json({ error: { code: "internal", message: "something went wrong" } });
}
