import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';

type RateLimitBucket = {
  windowStartedAtMs: number;
  count: number;
};

@Injectable()
export class IndexerMetricsAccessService {
  private readonly authRequired = (process.env.INDEXER_METRICS_AUTH_REQUIRED ?? 'false') === 'true';
  private readonly apiKey = process.env.INDEXER_METRICS_API_KEY?.trim() ?? '';
  private readonly rateLimitPerMinute = Number(process.env.INDEXER_METRICS_RATE_LIMIT_RPM ?? '0');
  private readonly rateLimitBuckets = new Map<string, RateLimitBucket>();

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
}
