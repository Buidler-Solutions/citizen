declare module 'express' {
  export function json(options?: { limit?: string | number }): (req: unknown, res: unknown, next: (error?: unknown) => void) => void;
  export function urlencoded(options?: {
    extended?: boolean;
    limit?: string | number;
  }): (req: unknown, res: unknown, next: (error?: unknown) => void) => void;
}
