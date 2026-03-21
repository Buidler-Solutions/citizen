export const ADMIN_TOKEN_KEY = 'citizenAdminToken';

export interface AdminSession {
  sub: string;
  role: 'super_admin' | 'admin' | 'user';
  username?: string;
  exp?: number;
  iat?: number;
}

function decodeBase64Url(input: string): string | null {
  try {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return atob(padded);
  } catch {
    return null;
  }
}

export function getAdminSession(token = typeof window !== 'undefined' ? window.localStorage.getItem(ADMIN_TOKEN_KEY) : null): AdminSession | null {
  if (!token) {
    return null;
  }

  const payload = token.split('.')[1];

  if (!payload) {
    return null;
  }

  const decoded = decodeBase64Url(payload);

  if (!decoded) {
    return null;
  }

  try {
    return JSON.parse(decoded) as AdminSession;
  } catch {
    return null;
  }
}
