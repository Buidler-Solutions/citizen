import type { IncomingMessage, ServerResponse } from "node:http";

/** Minimal dependency-free router mirroring the original NestJS REST shapes. */

export type Handler = (
  req: IncomingMessage,
  params: Record<string, string>,
  query: URLSearchParams,
  body: unknown
) => Promise<unknown> | unknown;

export interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: Handler;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: unknown;

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function badRequest(code: string, message: string, detail?: unknown): never {
  throw new HttpError(400, code, message, detail);
}

export function unauthorized(code: string, message: string): never {
  throw new HttpError(401, code, message);
}

export function notFound(code: string, message: string): never {
  throw new HttpError(404, code, message);
}

export class Router {
  private readonly routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method,
      pattern,
      segments: pattern.split("/").filter(Boolean),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: Handler) {
    return this.on("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler) {
    return this.on("POST", pattern, handler);
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | undefined {
    const parts = pathname.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < parts.length; i++) {
        const segment = route.segments[i];
        if (segment.startsWith(":")) {
          params[segment.slice(1)] = decodeURIComponent(parts[i]);
        } else if (segment !== parts[i]) {
          matched = false;
          break;
        }
      }
      if (matched) return { route, params };
    }
    return undefined;
  }

  listRoutes(): string[] {
    return this.routes.map((route) => `${route.method} ${route.pattern}`);
  }
}

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
