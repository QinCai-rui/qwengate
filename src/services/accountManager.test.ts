import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { accounts, bulkAddAccounts } from './accountManager.ts';

const addAccountMock = mock(async (email: string, password: string) => {
  if (password === 'failme') return { loginSucceeded: false, loginError: 'login failed' };
  return { loginSucceeded: true };
});

beforeEach(() => {
  accounts.length = 0;
  addAccountMock.mockClear();
});

describe('bulkAddAccounts (issue #46)', () => {
  test('imports valid accounts', async () => {
    const result = await bulkAddAccounts(
      [
        { email: 'a@b.com', password: 'p1' },
        { email: 'c@d.com', password: 'p2' },
      ],
      addAccountMock,
    );
    expect(result.added).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(addAccountMock).toHaveBeenCalledTimes(2);
    expect(result.results.every((r) => r.success)).toBe(true);
  });

  test('rejects invalid email and missing password', async () => {
    const result = await bulkAddAccounts(
      [
        { email: 'not-an-email', password: 'p1' },
        { email: 'ok@b.com', password: '' },
      ],
      addAccountMock,
    );
    expect(result.failed).toBe(2);
    expect(result.results[0].reason).toBe('invalid email format');
    expect(result.results[1].reason).toBe('missing password');
    expect(addAccountMock).toHaveBeenCalledTimes(0);
  });

  test('dedupes within batch and against existing', async () => {
    accounts.push({
      email: 'exists@b.com',
      password: 'x',
      state: null,
      lastUsed: 0,
      throttledUntil: 0,
      refreshInFlight: null,
      loginAttempt: 0,
      inFlight: 0,
      totalRequests: 0,
      disabled: false,
    });
    const result = await bulkAddAccounts(
      [
        { email: 'dup@b.com', password: 'p' },
        { email: 'DUP@b.com', password: 'p' },
        { email: 'exists@b.com', password: 'p' },
      ],
      addAccountMock,
    );
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.results.map((r) => r.reason)).toContain('duplicate in batch');
    expect(result.results.map((r) => r.reason)).toContain('already exists');
    expect(addAccountMock).toHaveBeenCalledTimes(1);
  });

  test('continues after a login failure', async () => {
    const result = await bulkAddAccounts(
      [
        { email: 'fail@b.com', password: 'failme' },
        { email: 'good@b.com', password: 'ok' },
      ],
      addAccountMock,
    );
    expect(result.added).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[1].success).toBe(true);
  });
});
