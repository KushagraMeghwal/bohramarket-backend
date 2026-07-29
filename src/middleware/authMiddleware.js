const jwt = require('jsonwebtoken');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const { TOKEN_COOKIE_NAME } = require('../utils/generateToken');

// Frontend and backend live on different domains, which makes the auth
// cookie a third-party cookie from the browser's point of view — browsers
// increasingly throttle or drop those outright, causing users to get
// silently logged out mid-session even though their login was never
// actually invalidated. The Authorization header is the reliable path (the
// frontend attaches it explicitly from a token it stores itself, so nothing
// about it depends on the browser's cookie policy); the cookie is kept only
// as a fallback for same-origin / non-browser callers.
const extractToken = (req) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length);
  }
  return req.cookies?.[TOKEN_COOKIE_NAME];
};

// Blocks the request unless a valid, active-user token is present.
const verifyToken = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }

  const user = await User.findById(decoded.id);
  if (!user || !user.isActive) {
    return res.status(401).json({ message: 'Account not found or suspended' });
  }

  req.user = user;
  next();
});

// Attaches req.user when a valid token cookie exists, but lets the request
// through regardless — for routes that serve both logged-out and logged-in users.
const optionalAuth = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) return next();

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (user?.isActive) req.user = user;
  } catch (err) {
    // invalid/expired token: continue as anonymous
  }

  next();
});

const requireRole = (allowedRoles) => (req, res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ message: 'Forbidden: insufficient role' });
  }
  next();
};

module.exports = { verifyToken, optionalAuth, requireRole };
