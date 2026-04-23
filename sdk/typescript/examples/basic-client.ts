import {
  CitizenNodeClient,
  Ed25519Signer,
  type SubmitTransactionArgs,
  type WaitForReceiptOptions
} from '../src/index.js';

/**
 * Minimal sample app for builders wiring the TypeScript SDK into their own services.
 *
 * This sample is intentionally compile-focused; it is not executed in tests because it
 * expects a reachable Citizen node and a valid signer key.
 */
export async function submitBuilderEntry(
  signerPrivateKeyPem: string,
  args: Omit<SubmitTransactionArgs, 'signer'>,
  _waitOptions?: WaitForReceiptOptions
): Promise<unknown> {
  const signer = new Ed25519Signer({
    signerId: 'did:example:builder',
    privateKeyPem: signerPrivateKeyPem
  });
  const client = new CitizenNodeClient({
    baseUrl: 'http://127.0.0.1:8080'
  });

  return client.submitTransaction({
    ...args,
    signer
  });
}
