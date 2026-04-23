export class Ed25519Signer {
  private signerId: string;
  private privateKeyPem: string;

  constructor({ signerId, privateKeyPem }: { signerId: string; privateKeyPem: string }) {
    if (!signerId) {
      throw new Error("signerId is required");
    }

    if (!privateKeyPem) {
      throw new Error("privateKeyPem is required");
    }

    this.signerId = signerId;
    this.privateKeyPem = privateKeyPem;
  }

  async getSignerId(): Promise<string> {
    return this.signerId;
  }

  async sign(message: string): Promise<string> {
    const { createPrivateKey, sign } = await import("node:crypto");
    const privateKey = createPrivateKey(this.privateKeyPem);
    const signature = sign(null, Buffer.from(message) as unknown as Uint8Array, privateKey);
    return `ed25519:${signature.toString("base64")}`;
  }
}
