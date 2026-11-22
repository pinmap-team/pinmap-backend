const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const userId = '12345678-1234-1234-1234-123456789012';
const subscriptionId = 'sub_' + 'a'.repeat(26);
const transactionId = 'txn_' + 'b'.repeat(26);
const secret = 'sb_secret_serveronly123';

function reply(body, status = 200) {
  return {ok: status >= 200 && status < 300, status, json: async () => body};
}
function response() {
  return {code: null, body: null, headers: {}, setHeader(k, v) {this.headers[k] = v;},
    status(code) {this.code = code; return this;}, json(body) {this.body = body; return this;}};
}
function setup({email = 'owner@example.com', subscription = false, checkout = false,
  transactionStatus = 'completed', cancelFails = false,
  deleteFails = false, authorized = true} = {}) {
  const calls = [];
  const billing = {
    id: (value, prefix) => prefix === 'txn' ? value === transactionId : value === subscriptionId,
    config: env => ({environment: env.PADDLE_ENVIRONMENT}),
    paddle: async (config, path, body) => {
      calls.push({kind: 'paddle', path, body, environment: config.environment});
      if (body) {
        if (cancelFails) throw Error('provider_failure');
        return {status: 'canceled'};
      }
      if (path === `/transactions/${transactionId}`)
        return {status: transactionStatus, subscription_id: subscriptionId};
      return {status: 'active'};
    }
  };
  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({kind: 'fetch', path, method: options.method || 'GET', headers: options.headers});
    if (path.includes('/admin/users/'))
      return options.method === 'DELETE' ? reply({}, deleteFails ? 503 : 200) : reply({email});
    if (path.endsWith('/pinmap_subscriptions'))
      return reply(subscription ? [{subscription_id: subscriptionId, environment: 'live'}] : []);
    if (path.endsWith('/pinmap_billing_checkouts'))
      return reply(checkout ? [{transaction_id: transactionId, environment: 'live'}] : []);
    if (path.endsWith('/pinmap_analysis_usage')) return reply({});
    throw Error('unexpected request ' + path);
  };
  const mock = {
    './content-extract': {supabaseConfig: () => ({origin: 'https://example.supabase.co', key: 'public'}),
      bearerToken: value => value === 'Bearer valid-token' ? 'valid-token' : null,
      authenticatedUser: async () => authorized ? {status: 200, userId} : {status: 401}},
    '../config/keys.cjs': {getKey: () => secret},
    '../lib/billing': billing,
    './auth/test-login': {email: 'pinmap2026@gmail.com'}
  };
  const context = {module: {exports: {}}, exports: {}, require: name => mock[name],
    fetch, URL, AbortSignal, process: {env: {}}, console};
  vm.runInNewContext(fs.readFileSync('api/account-delete.js', 'utf8'), context);
  return {handler: context.module.exports, calls};
}

test('account deletion requires the current user and rejects the shared test account', async () => {
  let app = setup({authorized: false}), res = response();
  await app.handler({method: 'DELETE', headers: {authorization: 'Bearer valid-token'}}, res);
  assert.equal(res.code, 401);
  assert.equal(app.calls.length, 0);
  app = setup({email: 'pinmap2026@gmail.com'}); res = response();
  await app.handler({method: 'DELETE', headers: {authorization: 'Bearer valid-token'}}, res);
  assert.equal(res.code, 403);
  assert.equal(app.calls.some(call => call.method === 'DELETE'), false);
});

test('active subscription is canceled before deleting account data', async () => {
  const app = setup({subscription: true}), res = response();
  await app.handler({method: 'DELETE', headers: {authorization: 'Bearer valid-token'}}, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.deleted, true);
  const cancel = app.calls.findIndex(call => call.path === `/subscriptions/${subscriptionId}/cancel`);
  const usage = app.calls.findIndex(call => call.path === '/rest/v1/pinmap_analysis_usage');
  const user = app.calls.findIndex(call => call.path === `/auth/v1/admin/users/${userId}` && call.method === 'DELETE');
  assert(cancel >= 0 && cancel < usage && usage < user);
  assert.equal(app.calls[cancel].body.effective_from, 'immediately');
  assert.equal(app.calls[user].headers.Authorization, `Bearer ${secret}`);
  assert.equal(JSON.stringify(res.body).includes(secret), false);
});

test('failed subscription cancellation leaves the account intact', async () => {
  const app = setup({subscription: true, cancelFails: true}), res = response();
  await app.handler({method: 'DELETE', headers: {authorization: 'Bearer valid-token'}}, res);
  assert.equal(res.code, 503);
  assert.equal(res.body.error, 'subscription_cancellation_failed');
  assert.equal(app.calls.some(call => call.method === 'DELETE'), false);
});

test('pending checkout blocks deletion even when an older subscription exists', async () => {
  const app = setup({subscription: true, checkout: true, transactionStatus: 'ready'}), res = response();
  await app.handler({method: 'DELETE', headers: {authorization: 'Bearer valid-token'}}, res);
  assert.equal(res.code, 503);
  assert.equal(res.body.error, 'checkout_pending');
  assert.equal(app.calls.some(call => call.method === 'DELETE'), false);
});

test('completed checkout without a webhook row still cancels its subscription', async () => {
  const app = setup({checkout: true}), res = response();
  await app.handler({method: 'DELETE', headers: {authorization: 'Bearer valid-token'}}, res);
  assert.equal(res.code, 200);
  assert(app.calls.some(call => call.path === `/subscriptions/${subscriptionId}/cancel`));
});

test('failed account deletion reports failure after billing cancellation', async () => {
  const app = setup({subscription: true, deleteFails: true}), res = response();
  await app.handler({method: 'DELETE', headers: {authorization: 'Bearer valid-token'}}, res);
  assert.equal(res.code, 503);
  assert.equal(res.body.error, 'account_delete_failed');
});
