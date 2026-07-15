const User = require('../models/User');
const Seller = require('../models/Seller');
const asyncHandler = require('../utils/asyncHandler');
const { generateToken, TOKEN_COOKIE_NAME, COOKIE_OPTIONS } = require('../utils/generateToken');
const { verifyFirebaseIdToken } = require('../utils/verifyFirebaseToken');

// The frontend's route guards decide where to send a seller (onboarding form,
// pending-approval screen, or dashboard) based on this status, so it has to
// travel with "the user profile" rather than requiring a separate call.
const serializeUser = async (user) => {
  const payload = {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    addresses: user.addresses,
  };

  if (user.role === 'seller') {
    const seller = await Seller.findOne({ user: user._id }).select('status rejectionReason');
    payload.sellerStatus = seller?.status;
    payload.sellerId = seller?._id;
    payload.sellerRejectionReason = seller?.rejectionReason;
  }

  return payload;
};

// POST /api/auth/register
const register = asyncHandler(async (req, res) => {
  const { name, email, password, phone, role } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Name, email and password are required' });
  }

  if (role && !['customer', 'seller'].includes(role)) {
    return res.status(400).json({ message: "role must be 'customer' or 'seller'" });
  }

  const existing = await User.findOne({ email });
  if (existing) {
    return res.status(409).json({ message: 'Email already registered' });
  }

  const user = await User.create({ name, email, password, phone, role: role || 'customer' });

  generateToken(res, user._id, user.role);

  res.status(201).json({ user: await serializeUser(user) });
});

// POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  const user = await User.findOne({ email }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  if (!user.isActive) {
    return res.status(403).json({ message: 'Account suspended' });
  }

  generateToken(res, user._id, user.role);

  res.json({ user: await serializeUser(user) });
});

// POST /api/auth/google
// Body: { idToken } — a Firebase ID token from the client's
// signInWithPopup(new GoogleAuthProvider()) call. Verified server-side
// against Google's public keys (see verifyFirebaseToken.js) rather than
// trusted as-is, same principle as never trusting client-supplied prices.
const googleAuth = asyncHandler(async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) {
    return res.status(400).json({ message: 'idToken is required' });
  }

  let decoded;
  try {
    decoded = await verifyFirebaseIdToken(idToken);
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired Google sign-in token' });
  }

  if (!decoded.email) {
    return res.status(400).json({ message: 'Google account has no email on file' });
  }

  let user = await User.findOne({ email: decoded.email });

  if (!user) {
    user = await User.create({
      name: decoded.name || decoded.email.split('@')[0],
      email: decoded.email,
      avatarUrl: decoded.picture,
      role: 'customer',
      authProvider: 'google',
      googleId: decoded.sub,
    });
  } else if (!user.googleId) {
    // Existing email/password account signing in with Google for the first
    // time — link it rather than creating a duplicate user for the same
    // email; their original password (if any) keeps working too.
    user.googleId = decoded.sub;
    await user.save();
  }

  if (!user.isActive) {
    return res.status(403).json({ message: 'Account suspended' });
  }

  generateToken(res, user._id, user.role);

  res.json({ user: await serializeUser(user) });
});

// POST /api/auth/logout
const logout = (req, res) => {
  res.clearCookie(TOKEN_COOKIE_NAME, COOKIE_OPTIONS);
  res.json({ message: 'Logged out' });
};

// GET /api/auth/me
const getMe = asyncHandler(async (req, res) => {
  res.json({ user: await serializeUser(req.user) });
});

module.exports = { register, login, googleAuth, logout, getMe };
