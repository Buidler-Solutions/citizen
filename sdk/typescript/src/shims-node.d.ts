declare const Buffer: {
  from(value: ArrayBuffer | ArrayBufferView | string): {
    toString(encoding?: string): string;
  };
};

declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array): { digest(encoding: string): string };
  };

  export function createPrivateKey(pem: string): unknown;
  export function sign(
    algorithm: string | null,
    data: Uint8Array,
    key: unknown
  ): {
    toString(encoding?: string): string;
  };
}
