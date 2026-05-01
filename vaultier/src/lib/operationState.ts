export type OperationState =
  | 'idle'
  | 'preflight'
  | 'writing'
  | 'flushing'
  | 'verify_required'
  | 'completed'
  | 'action_required';

export type ErrorIdentifier =
  | 'unsupported_schema'
  | 'slot_not_found'
  | 'decrypt_failed'
  | 'checksum_mismatch'
  | 'invalid_payload'
  | 'mount_unwritable'
  | 'insufficient_space'
  | 'path_invalid'
  | 'media_unavailable'
  | 'manifest_signature_invalid';

export const OPERATION_STATE_COPY: Record<OperationState, { title: string; detail: string }> = {
  idle: {
    title: 'Ready to start',
    detail: 'Select a removable target and configure decoy/critical slots.',
  },
  preflight: {
    title: 'Running preflight checks',
    detail: 'Validating writable mount path and portable metadata prerequisites.',
  },
  writing: {
    title: 'Writing encrypted vault data',
    detail: 'Creating or updating slot payloads with encrypted wallet backup artifacts.',
  },
  flushing: {
    title: 'Flushing writes',
    detail: 'Sync in progress: keep media connected until flush and rename complete.',
  },
  verify_required: {
    title: 'Verification required',
    detail: 'Run deterministic verification before marking this media as recovery-ready.',
  },
  completed: {
    title: 'Operation completed',
    detail: 'Backup workflow finished. Use safe-removal checklist before unplugging media.',
  },
  action_required: {
    title: 'Action required',
    detail: 'Resolve the highlighted issue, then retry with deterministic error guidance.',
  },
};

export const ERROR_COPY: Record<ErrorIdentifier, { headline: string; nextAction: string }> = {
  unsupported_schema: {
    headline: 'Vault schema is not supported by this app version.',
    nextAction: 'Use a compatible release or run an explicit migration command before restore.',
  },
  slot_not_found: {
    headline: 'Requested slot role was not found in this vault.',
    nextAction: 'Verify slot inventory and retry with the correct role (decoy or critical).',
  },
  decrypt_failed: {
    headline: 'Decryption failed for the selected slot.',
    nextAction: 'Re-enter the slot passphrase and confirm you selected the intended slot role.',
  },
  checksum_mismatch: {
    headline: 'Integrity check failed due to checksum mismatch.',
    nextAction: 'Stop restore and switch to a known-good duplicate media backup.',
  },
  invalid_payload: {
    headline: 'Vault payload is malformed or incomplete.',
    nextAction: 'Run verify and use diagnostics to identify corruption before any recovery attempt.',
  },
  mount_unwritable: {
    headline: 'Selected media path is not writable.',
    nextAction: 'Remount with write access and retry after confirming filesystem permissions.',
  },
  insufficient_space: {
    headline: 'Not enough free space on selected media.',
    nextAction: 'Free disk space or switch to a larger removable drive, then retry backup.',
  },
  path_invalid: {
    headline: 'Target path is invalid for this operating environment.',
    nextAction: 'Choose a valid removable mount path and avoid unsupported characters.',
  },
  media_unavailable: {
    headline: 'Removable media became unavailable during operation.',
    nextAction: 'Reconnect media, run verification, and only continue if integrity checks pass.',
  },
  manifest_signature_invalid: {
    headline: 'Signed backup manifest verification failed.',
    nextAction: 'Stop recovery, quarantine this media, and use a previously verified duplicate backup.',
  },
};
