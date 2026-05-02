declare module 'node:fs' {
  export function readFileSync(path: string, options?: { encoding?: string } | string): string;
}

declare module 'node:path' {
  export function resolve(...paths: string[]): string;
}
