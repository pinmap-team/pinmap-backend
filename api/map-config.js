// Browser map credentials are public identifiers. Keep server-only map secrets out of this response.
const { getKey } = require('../config/keys.cjs');
module.exports = function mapConfig(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');
  const googleBrowserKey = getKey('GOOGLE_MAPS_BROWSER_KEY');
  // This public browser identifier is rotated in Vercel without resealing the
  // older encrypted registry. Never return the NAVER client secret here.
  const naverClientId = (process.env.NAVER_MAP_CLIENT_ID || '').trim();
  return res.status(200).json({
    defaultProvider: naverClientId ? 'naver' : 'google',
    available: { google: Boolean(googleBrowserKey), naver: Boolean(naverClientId) },
    googleBrowserKey, naverClientId
  });
};
