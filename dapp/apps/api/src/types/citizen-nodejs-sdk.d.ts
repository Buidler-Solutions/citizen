declare module "@citizen-protocol/nodejs-sdk" {
  export interface CitizenNodeClientArgs {
    baseUrl: string;
  }

  export interface CitizenNodeClientInstance {
    submitEnvelope(envelope: unknown): Promise<unknown>;
  }

  export class CitizenNodeClient implements CitizenNodeClientInstance {
    constructor(args: CitizenNodeClientArgs);
    submitEnvelope(envelope: unknown): Promise<unknown>;
  }
}
