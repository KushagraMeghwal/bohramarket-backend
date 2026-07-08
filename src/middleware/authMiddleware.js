const jwt = require('jsonwebtoken');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const { TOKEN_COOKIE_NAME } = require('../utils/generateToken');

// Blocks the request unless a valid, active-user token cookie is present.
const verifyToken = asyncHandler(async (req, res, next) => {
  const token = req.cookies?.[TOKEN_COOKIE_NAME];

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
  const token = req.cookies?.[TOKEN_COOKIE_NAME];
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
