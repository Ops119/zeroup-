import type { Server } from "http";
import type { Express } from "express";
import { BaseError, ContractFunctionRevertedError } from "viem";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function httpError(status: number, message: string): HttpError {
  return new HttpError(status, message);
}

/** Pulls the revert reason out of viem errors so clients see something useful. */
export function errorMessage(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return revert.data?.errorName ?? revert.reason ?? revert.shortMessage;
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Fixed-window limiter keyed by caller (IP, address...). */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  take(key: string, now = Date.now()): boolean {
    const k = key.toLowerCase();
    const h = this.hits.get(k);
    if (!h || now >= h.resetAt) {
      this.hits.set(k, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (h.count >= this.limit) return false;
    h.count++;
    return true;
  }
}

export function listen(app: Express, port: number, host = "127.0.0.1"): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, (err?: Error) => (err ? reject(err) : resolve(server)));
  });
}
