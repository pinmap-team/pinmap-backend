const {supabaseConfig, bearerToken, authenticatedUser} = require('./content-extract');
const {getKey} = require('../config/keys.cjs');
const Billing = require('../lib/billing');
const TEST_EMAIL = require('./auth/test-login').email;

const USER_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

function storageConfig(publicConfig, env = process.env) {
  const secret = getKey('SUPABASE_SECRET_KEY', env);
  return publicConfig && /^sb_secret_[A-Za-z0-9_-]{8,}$/.test(secret)
    ? {...publicConfig, secret} : null;
}

async function storageRequest(config, path, method = 'GET', fetcher = fetch) {
  const response = await fetcher(new URL('/rest/v1/' + path, config.origin), {
    method,
    headers: {apikey: config.secret, Authorization: `Bearer ${config.secret}`},
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw Error('account_storage_unavailable');
  return method === 'GET' ? response.json() : null;
}

async function cancelSubscriptions(config, userId, billing = Billing, fetcher = fetch) {
  const rows = await storageRequest(config,
    `pinmap_subscriptions?select=subscription_id,environment&user_id=eq.${userId}`, 'GET', fetcher);
  if (!Array.isArray(rows)) throw Error('account_storage_unavailable');
  // A checkout can finish before its webhook has written a subscription row.
  // Inspect recent transactions even when an older subscription already exists.
  const since = encodeURIComponent(new Date(Date.now() - 30 * 60 * 1000).toISOString());
  const checkouts = await storageRequest(config,
    `pinmap_billing_checkouts?select=transaction_id,environment&user_id=eq.${userId}&created_at=gte.${since}`,
    'GET', fetcher);
  if (!Array.isArray(checkouts)) throw Error('account_storage_unavailable');
  const subscriptions = new Map(rows.map(row => [row.subscription_id, row.environment]));
  for (const checkout of checkouts) {
    if (!['sandbox', 'live'].includes(checkout.environment) ||
        !billing.id(checkout.transaction_id, 'txn')) throw Error('checkout_pending');
    const provider = billing.config({...process.env, PADDLE_ENVIRONMENT: checkout.environment});
    const transaction = await billing.paddle(provider, `/transactions/${checkout.transaction_id}`);
    if (transaction.status !== 'completed' || !billing.id(transaction.subscription_id, 'sub'))
      throw Error('checkout_pending');
    if (subscriptions.has(transaction.subscription_id) &&
        subscriptions.get(transaction.subscription_id) !== checkout.environment)
      throw Error('subscription_unavailable');
    subscriptions.set(transaction.subscription_id, checkout.environment);
  }
  for (const [subscriptionId, environment] of subscriptions) {
    if (!billing.id(subscriptionId, 'sub') || !['sandbox', 'live'].includes(environment))
      throw Error('subscription_unavailable');
    const provider = billing.config({...process.env, PADDLE_ENVIRONMENT: environment});
    const subscription = await billing.paddle(provider, `/subscriptions/${subscriptionId}`);
    if (subscription.status === 'canceled') continue;
    if (!['active', 'past_due', 'paused', 'trialing'].includes(subscription.status))
      throw Error('subscription_unavailable');
    const canceled = await billing.paddle(provider, `/subscriptions/${subscriptionId}/cancel`,
      {effective_from: 'immediately'});
    if (canceled.status !== 'canceled') throw Error('subscription_unavailable');
  }
}

async function deleteAccount(config, userId, fetcher = fetch) {
  // Usage also references subscriptions without ON DELETE CASCADE. Remove it first;
  // the remaining account tables and metadata cascade with auth.users.
  await storageRequest(config, `pinmap_analysis_usage?user_id=eq.${userId}`, 'DELETE', fetcher);
  const response = await fetcher(new URL(`/auth/v1/admin/users/${userId}`, config.origin), {
    method: 'DELETE',
    headers: {apikey: config.secret, Authorization: `Bearer ${config.secret}`},
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw Error('account_delete_failed');
}

async function isTeamTestAccount(config, userId, fetcher = fetch) {
  const response = await fetcher(new URL(`/auth/v1/admin/users/${userId}`, config.origin), {
    headers: {apikey: config.secret, Authorization: `Bearer ${config.secret}`},
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw Error('account_lookup_failed');
  const user = await response.json();
  return String(user.email || '').toLowerCase() === TEST_EMAIL;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE');
    return res.status(405).json({error: 'method_not_allowed'});
  }
  const config = storageConfig(supabaseConfig());
  if (!config) return res.status(503).json({error: 'account_delete_unavailable'});
  const token = bearerToken(req.headers?.authorization);
  if (!token) return res.status(401).json({error: 'authentication_required'});
  const auth = await authenticatedUser(config, token);
  if (auth.status !== 200 || !USER_ID.test(auth.userId || ''))
    return res.status(auth.status === 503 ? 503 : 401).json({error: auth.status === 503 ? 'auth_unavailable' : 'authentication_required'});
  try {
    if (await isTeamTestAccount(config, auth.userId))
      return res.status(403).json({error: 'test_account_cannot_delete'});
  } catch {
    return res.status(503).json({error: 'account_delete_unavailable'});
  }
  try {
    await cancelSubscriptions(config, auth.userId);
  } catch (error) {
    return res.status(503).json({error: error.message === 'checkout_pending'
      ? 'checkout_pending' : 'subscription_cancellation_failed'});
  }
  try {
    await deleteAccount(config, auth.userId);
    return res.status(200).json({deleted: true});
  } catch {
    return res.status(503).json({error: 'account_delete_failed'});
  }
};

module.exports.storageConfig = storageConfig;
module.exports.cancelSubscriptions = cancelSubscriptions;
module.exports.deleteAccount = deleteAccount;
module.exports.isTeamTestAccount = isTeamTestAccount;
