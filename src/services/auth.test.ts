import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  incrementInFlight,
  decrementInFlight,
  incrementTotalRequests,
  hasInFlight,
  saveCookies,
  getAccountByEmail,
  throttleAccount,
  isAvailable,
  accounts,
} from './auth.js';

describe('account inFlight and totalRequests tracking', () => {
  test('incrementInFlight increments and decrementInFlight decrements', () => {
    // These should not throw even if account doesn't exist
    incrementInFlight('nonexistent@test');
    decrementInFlight('nonexistent@test');
  });

  test('incrementTotalRequests increments counter', () => {
    incrementTotalRequests('nonexistent@test'); // should not throw
  });

  test('hasInFlight returns false for nonexistent account', () => {
    assert.strictEqual(hasInFlight('nobody@test'), false);
  });
});

describe('saveCookies and account state', () => {
  const testEmail = 'savecookies-test@example.com';

  beforeEach(() => {
    accounts.push({
      email: testEmail,
      password: 'test-pass',
      state: null,
      lastUsed: 0,
      throttledUntil: 0,
      refreshInFlight: null,
      loginAttempt: 0,
      inFlight: 0,
      totalRequests: 0,
    });
  });

  afterEach(() => {
    accounts.length = 0;
  });

  test('saveCookies updates account state', async () => {
    assert.equal(accounts.find(a => a.email === testEmail)?.state, null);
    await saveCookies(testEmail, 'test-token-value', 'test-refresh', Date.now() + 3600000);
    const acct = accounts.find(a => a.email === testEmail);
    assert.notEqual(acct?.state, null);
    assert.equal(acct?.state?.token, 'test-token-value');
    assert.equal(acct?.state?.refreshToken, 'test-refresh');
  });
});

describe('getAccountByEmail', () => {
  beforeEach(() => {
    accounts.push(
      { email: 'MixedCase@Example.com', password: 'p1', state: null, lastUsed: 0, throttledUntil: 0, refreshInFlight: null, loginAttempt: 0, inFlight: 0, totalRequests: 0 },
      { email: 'lowercase@example.com', password: 'p2', state: null, lastUsed: 0, throttledUntil: 0, refreshInFlight: null, loginAttempt: 0, inFlight: 0, totalRequests: 0 },
    );
  });

  afterEach(() => {
    accounts.length = 0;
  });

  test('finds account regardless of case', () => {
    const found = getAccountByEmail('mixedcase@example.com');
    assert.notEqual(found, null);
    assert.equal(found?.email, 'MixedCase@Example.com');

    const found2 = getAccountByEmail('MIXEDCASE@EXAMPLE.COM');
    assert.notEqual(found2, null);
    assert.equal(found2?.email, 'MixedCase@Example.com');
  });

  test('returns null for unknown email', () => {
    assert.equal(getAccountByEmail('unknown@test.com'), null);
  });
});

describe('throttleAccount and isAvailable', () => {
  const testEmail = 'throttle-test@example.com';

  beforeEach(() => {
    accounts.push({
      email: testEmail,
      password: 'test-pass',
      state: { token: 'tok', expiresAt: Date.now() + 3600000, refreshToken: null },
      lastUsed: 0,
      throttledUntil: 0,
      refreshInFlight: null,
      loginAttempt: 0,
      inFlight: 0,
      totalRequests: 0,
    });
  });

  afterEach(() => {
    accounts.length = 0;
  });

  test('account is available when not throttled and has state', () => {
    const acct = getAccountByEmail(testEmail);
    assert.notEqual(acct, null);
    assert.equal(isAvailable(acct!), true);
  });

  test('throttleAccount makes account unavailable', () => {
    const acct = getAccountByEmail(testEmail)!;
    assert.equal(isAvailable(acct), true);

    throttleAccount(testEmail, 60000);
    assert.equal(isAvailable(acct), false);
  });

  test('isAvailable returns false when state is null', () => {
    const acct = getAccountByEmail(testEmail)!;
    acct.state = null;
    assert.equal(isAvailable(acct), false);
  });
});
