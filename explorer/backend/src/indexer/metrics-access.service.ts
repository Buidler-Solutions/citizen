import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { IndexerDeploymentProfile } from './metrics.types';

type RateLimitBucket = {
  windowStartedAtMs: number;
  count: number;
};

@Injectable()
export class IndexerMetricsAccessService {
  private readonly deploymentProfile = this.resolveDeploymentProfile();
  private readonly authRequired =
    (process.env.INDEXER_METRICS_AUTH_REQUIRED ??
      String(this.profileDefaults(this.deploymentProfile).authRequired)) === 'true';
  private readonly apiKey = process.env.INDEXER_METRICS_API_KEY?.trim() ?? '';
  private readonly rateLimitPerMinute = Number(
    process.env.INDEXER_METRICS_RATE_LIMIT_RPM ??
      String(this.profileDefaults(this.deploymentProfile).rateLimitPerMinute),
  );
  private readonly oncallRunbook =
    process.env.INDEXER_METRICS_ONCALL_RUNBOOK ??
    'citizen-protocol/docs/INDEXER_METRICS_ROLLOUT_COMPLETION.md';
  private readonly releaseNotesChecklist =
    process.env.INDEXER_METRICS_RELEASE_NOTES_CHECKLIST ??
    'citizen-protocol/docs/INDEXER_METRICS_ROLLOUT_COMPLETION.md#4-release-notes-checklist-indexer-metrics';
  private readonly rateLimitBuckets = new Map<string, RateLimitBucket>();

  getAccessPolicySnapshot(): {
    profile: IndexerDeploymentProfile;
    metrics_auth_required: boolean;
    metrics_rate_limit_rpm: number;
    oncall_runbook: string;
    release_notes_checklist: string;
  } {
    return {
      profile: this.deploymentProfile,
      metrics_auth_required: this.authRequired,
      metrics_rate_limit_rpm: this.rateLimitPerMinute,
      oncall_runbook: this.oncallRunbook,
      release_notes_checklist: this.releaseNotesChecklist,
    };
  }

  enforce(headers: Record<string, string | string[] | undefined>, clientIp: string | undefined): void {
    const clientKey = this.resolveClientKey(headers, clientIp);

    if (this.authRequired) {
      if (!this.apiKey) {
        throw new UnauthorizedException(
          'metrics auth is required but INDEXER_METRICS_API_KEY is not configured on the server',
        );
      }
      if (!clientKey || clientKey !== this.apiKey) {
        throw new UnauthorizedException('missing or invalid metrics API key');
      }
    }

    if (this.rateLimitPerMinute <= 0) {
      return;
    }

    const subject = clientKey || clientIp || 'anonymous';
    const now = Date.now();
    const oneMinuteMs = 60_000;
    const bucket = this.rateLimitBuckets.get(subject);

    if (!bucket || now - bucket.windowStartedAtMs >= oneMinuteMs) {
      this.rateLimitBuckets.set(subject, { windowStartedAtMs: now, count: 1 });
      return;
    }

    if (bucket.count >= this.rateLimitPerMinute) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((oneMinuteMs - (now - bucket.windowStartedAtMs)) / 1000),
      );
      throw new HttpException(
        `metrics rate limit exceeded: max ${this.rateLimitPerMinute} requests/minute (retry_after_seconds=${retryAfterSeconds})`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    bucket.count += 1;
  }

  private resolveClientKey(headers: Record<string, string | string[] | undefined>, clientIp: string | undefined): string | undefined {
    const headerKey = this.headerValue(headers['x-indexer-api-key']);
    if (headerKey) {
      return headerKey;
    }

    const authorization = this.headerValue(headers.authorization);
    if (authorization?.startsWith('Bearer ')) {
      const token = authorization.slice('Bearer '.length).trim();
      if (token.length > 0) {
        return token;
      }
    }

    return clientIp;
  }

  private headerValue(raw: string | string[] | undefined): string | undefined {
    if (Array.isArray(raw)) {
      return raw[0]?.trim() || undefined;
    }
    return raw?.trim() || undefined;
  }

  private resolveDeploymentProfile(): IndexerDeploymentProfile {
    const raw = (process.env.INDEXER_METRICS_DEPLOYMENT_PROFILE ?? 'localnet').trim().toLowerCase();
    if (raw === 'localnet' || raw === 'shared-dev' || raw === 'production-candidate') {
      return raw;
    }
    return 'localnet';
  }

  private profileDefaults(profile: IndexerDeploymentProfile): {
    authRequired: boolean;
    rateLimitPerMinute: number;
  } {
    if (profile === 'shared-dev') {
      return { authRequired: true, rateLimitPerMinute: 120 };
    }
    if (profile === 'production-candidate') {
      return { authRequired: true, rateLimitPerMinute: 60 };
    }
    return { authRequired: false, rateLimitPerMinute: 0 };
  }
}
