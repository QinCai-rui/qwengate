import { describe, expect, test, beforeEach } from 'bun:test';
import { config } from '../services/configService.ts';
import {
  createSessionCookieValue,
  verifySessionCookieValue,
  hasValidDashboardSession,
  clearSessionCookieHeader,
} from './auth.ts';

// Fake request context for hasValidDashboardSession
function fakeC(cookieHeader?: string) {
  return {
    req: { header: (name: string) => (name === 'cookie' ? cookieHeader : undefined) },
  } as any;
}

beforeEach(() => {
  delete process.env.DASHBOARD_PASSWORD;
  config.set('DASHBOARD_PASSWORD', '123456');
});

describe('dashboard session cookie (issue #45)', () => {
  test('cookie value verifies against the configured password', () => {
    const cookie = createSessionCookieValue();
    expect(cookie.startsWith('v1.')).toBe(true);
    expect(verifySessionCookieValue(cookie)).toBe(true);
  });

  test('cookie invalidates when password changes', () => {
    const cookie = createSessionCookieValue();
    config.set('DASHBOARD_PASSWORD', 'different-password');
    expect(verifySessionCookieValue(cookie)).toBe(false);
  });

  test('empty / malformed cookies rejected', () => {
    expect(verifySessionCookieValue(undefined)).toBe(false);
    expect(verifySessionCookieValue('')).toBe(false);
    expect(verifySessionCookieValue('garbage')).toBe(false);
    expect(verifySessionCookieValue('v1.')).toBe(false);
  });

  test('hasValidDashboardSession parses the cookie header', () => {
    const cookie = createSessionCookieValue();
    expect(hasValidDashboardSession(fakeC(`qg_dash=${encodeURIComponent(cookie)}`))).toBe(true);
    expect(hasValidDashboardSession(fakeC('other=1; qg_dash=' + encodeURIComponent(cookie)))).toBe(true);
    expect(hasValidDashboardSession(fakeC('other=1'))).toBe(false);
    expect(hasValidDashboardSession(fakeC(undefined))).toBe(false);
  });

  test('clearSessionCookieHeader expires the cookie', () => {
    const header = clearSessionCookieHeader();
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('HttpOnly');
  });

  test('default password 123456 used when config is empty', () => {
    config.set('DASHBOARD_PASSWORD', '');
    const cookie = createSessionCookieValue();
    expect(verifySessionCookieValue(cookie)).toBe(true);
  });
});
