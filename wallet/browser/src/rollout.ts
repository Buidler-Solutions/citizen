export type ApprovalUiRolloutStage = 'internal' | 'beta' | 'general' | 'disabled';

const STAGE_ORDER: ApprovalUiRolloutStage[] = ['internal', 'beta', 'general'];

export function parseApprovalUiRolloutStage(value: unknown): ApprovalUiRolloutStage {
  if (typeof value !== 'string') {
    return 'internal';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'internal' || normalized === 'beta' || normalized === 'general' || normalized === 'disabled') {
    return normalized;
  }
  return 'internal';
}

export function isApprovalUiEnabled(stage: ApprovalUiRolloutStage): boolean {
  return stage !== 'disabled';
}

export function isStageAtLeast(
  currentStage: ApprovalUiRolloutStage,
  requiredStage: Exclude<ApprovalUiRolloutStage, 'disabled'>,
): boolean {
  if (currentStage === 'disabled') {
    return false;
  }
  return STAGE_ORDER.indexOf(currentStage) >= STAGE_ORDER.indexOf(requiredStage);
}

export function getApprovalUiRolloutStageFromEnv(): ApprovalUiRolloutStage {
  const envValue = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env?.VITE_WALLET_APPROVAL_UI_ROLLOUT;
  return parseApprovalUiRolloutStage(envValue);
}
