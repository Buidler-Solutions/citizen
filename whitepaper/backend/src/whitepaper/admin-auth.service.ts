import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

type AdminTokenPayload = {
  role: 'admin';
  exp: number;
};

@Injectable()
export class AdminAuthService {
  login(password: string) {
    const expectedPassword = process.env.WHITEPAPER_ADMIN_PASSWORD;
    if (!expectedPassword) {
      throw new UnauthorizedException('Admin setup is incomplete on the server');
    }

    if (password !== expectedPassword) {
      throw new UnauthorizedException('Invalid admin credentials');
    }

    return {
      token: this.signToken({ role: 'admin', exp: Date.now() + 1000 * 60 * 60 * 8 }),
      expiresInSeconds: 60 * 60 * 8,
    };
  }

  verifyToken(token: string): AdminTokenPayload {
    const secret = this.getSecret();
    const [encodedPayload, signature] = token.split('.');

    if (!encodedPayload || !signature) {
      throw new UnauthorizedException('Invalid admin token format');
    }

    const expectedSignature = createHmac('sha256', secret).update(encodedPayload).digest('hex');
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
      throw new UnauthorizedException('Invalid admin token');
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as AdminTokenPayload;
    if (payload.role !== 'admin' || payload.exp < Date.now()) {
      throw new UnauthorizedException('Admin token expired');
    }

    return payload;
  }

  private signToken(payload: AdminTokenPayload) {
    const secret = this.getSecret();
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', secret).update(encodedPayload).digest('hex');
    return `${encodedPayload}.${signature}`;
  }

  private getSecret() {
    return process.env.WHITEPAPER_ADMIN_SECRET ?? process.env.JWT_SECRET ?? 'whitepaper-admin-dev-secret';
  }
}
