import type {
  BuilderCreditsAction,
  BuilderCreditsPayload,
  CitizenSigner,
  CreateFormCommitmentReceiptArgs,
  CreateMultisigCreditGrantArgs,
  CreateSponsorshipUsageArgs,
  SubmitTransactionArgs,
  WrapEnvelopeMultiArgs
} from "../src/index";
import { CitizenNodeClient, createFormCommitmentReceipt } from "../src/index";

const signer: CitizenSigner = {
  async getSignerId() {
    return "did:ledger:builder:demo";
  },
  async sign(_message: string) {
    return "sig:abc";
  }
};

const submitArgs: SubmitTransactionArgs = {
  namespace: "audit.procurement",
  action: "RECORD_EVENT",
  objectId: "PO-1",
  payload: { event: "OPENED" },
  signer
};

const validAction: BuilderCreditsAction = "SPONSOR_USAGE";
const validPayload: BuilderCreditsPayload = {
  amount: 25,
  credit_grant_id: "grant-1",
  sponsorship_id: "s-1",
  sponsored_did: "did:ledger:user1"
};

const formCommitment: CreateFormCommitmentReceiptArgs = {
  formId: "form-1",
  dataHash: "sha256:abc123",
  encryptedFormUrl: "https://storage.citizen.local/form-1"
};

const creditGrant: CreateMultisigCreditGrantArgs = {
  builderId: "builder:alpha",
  amount: 10,
  multisigProofs: [{ approver: "did:ledger:gov", public_key: "ed25519:key", signature: "sig" }]
};

const sponsorUsage: CreateSponsorshipUsageArgs = {
  builderId: "builder:alpha",
  amount: 5,
  creditGrantId: "grant-1",
  sponsorshipId: "s-1",
  sponsoredDid: "did:ledger:user1"
};

const multisigArgs: WrapEnvelopeMultiArgs = {
  entry: {
    entry_id: "entry-1",
    namespace: "audit.procurement",
    action: "RECORD_EVENT",
    object_id: "PO-1",
    payload: {},
    author: "did:ledger:builder:demo",
    timestamp: 1
  },
  signer,
  multisigPolicy: { threshold: 1 }
};

void validAction;
void validPayload;
void formCommitment;
void creditGrant;
void sponsorUsage;
void multisigArgs;
void createFormCommitmentReceipt(formCommitment);

const client = new CitizenNodeClient({ baseUrl: "http://127.0.0.1:8080", fetchImpl: fetch });
void client.submitTransaction(submitArgs);
