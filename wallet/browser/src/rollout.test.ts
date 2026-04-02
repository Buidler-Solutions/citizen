import { describe, expect, it } from 'vitest';
import {
  isApprovalUiEnabled,
  isStageAtLeast,
  parseApprovalUiRolloutStage,
} from './rollout';

describe('approval ui rollout parsing', () => {
  it('defaults to internal for unknown values', () => {
    expect(parseApprovalUiRolloutStage(undefined)).toBe('internal');
    expect(parseApprovalUiRolloutStage('')).toBe('internal');
    expect(parseApprovalUiRolloutStage('nope')).toBe('internal');
  });

  it('parses known stages case-insensitively', () => {
    expect(parseApprovalUiRolloutStage('BETA')).toBe('beta');
    expect(parseApprovalUiRolloutStage('general')).toBe('general');
    expect(parseApprovalUiRolloutStage('disabled')).toBe('disabled');
  });

  it('reports enablement state from rollout stage', () => {
    expect(isApprovalUiEnabled('internal')).toBe(true);
    expect(isApprovalUiEnabled('disabled')).toBe(false);
  });

  it('compares rollout order', () => {
    expect(isStageAtLeast('internal', 'internal')).toBe(true);
    expect(isStageAtLeast('beta', 'internal')).toBe(true);
    expect(isStageAtLeast('beta', 'general')).toBe(false);
    expect(isStageAtLeast('disabled', 'internal')).toBe(false);
  });
});
