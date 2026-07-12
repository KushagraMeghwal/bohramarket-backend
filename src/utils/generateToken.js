const jwt = require('jsonwebtoken');

const TOKEN_COOKIE_NAME = 'token';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Frontend (Firebase Hosting) and backend (Railway) live on different domains,
// so the auth cookie is cross-site: it needs SameSite=None (which in turn
// requires Secure) or browsers will silently drop it on fetch/XHR requests.
const isProduction = process.env.NODE_ENV === 'production';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? 'none' : 'lax',
};

const generateToken = (res, userId, role) => {
  const token = jwt.sign({ id: userId, role }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });

  res.cookie(TOKEN_COOKIE_NAME, token, {
    ...COOKIE_OPTIONS,
    maxAge: COOKIE_MAX_AGE_MS,
  });

  return token;
};

module.exports = { generateToken, TOKEN_COOKIE_NAME, COOKIE_OPTIONS };
