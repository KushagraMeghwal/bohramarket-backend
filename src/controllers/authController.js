const User = require('../models/User');
const Seller = require('../models/Seller');
const asyncHandler = require('../utils/asyncHandler');
const { generateToken, TOKEN_COOKIE_NAME, COOKIE_OPTIONS } = require('../utils/generateToken');
const { verifyFirebaseIdToken } = require('../utils/verifyFirebaseToken');
const { sendOtpEmail, isConfigured: isEmailConfigured } = require('../utils/mailer');

const generateOtp = () => String(Math.floor(100000 + Math.random() * 900000));

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

  const user = await User.create({ name, email, password, phone, role: role || 'customer', isEmailVerified: false });

  const otp = generateOtp();
  await user.setEmailOtp(otp);
  await user.save();
  await sendOtpEmail(user.email, otp);

  // No token/cookie yet — the account exists but can't log in until the OTP
  // is verified (see verifyOtp below), so the frontend must route straight
  // to the "enter the code we emailed you" step instead of into the app.
  // devOtp is only ever included while no real SMTP is configured — nothing
  // is actually being emailed in that case, so there's nothing to leak, and
  // it lets the verify page show the code directly for testing without
  // needing Railway log access. It disappears the moment SMTP is set up.
  res.status(201).json({
    pendingVerification: true,
    email: user.email,
    message: 'We sent a verification code to your email',
    ...(isEmailConfigured ? {} : { devOtp: otp }),
  });
});

// POST /api/auth/verify-otp — completes registration (or a login blocked by
// an unverified email) once the user supplies the code emailed to them.
const verifyOtp = asyncHandler(async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ message: 'Email and OTP are required' });
  }

  const user = await User.findOne({ email }).select('+emailOtp +emailOtpExpires');
  if (!user || !(await user.compareEmailOtp(otp))) {
    return res.status(400).json({ message: 'Invalid or expired code' });
  }

  user.isEmailVerified = true;
  user.emailOtp = undefined;
  user.emailOtpExpires = undefined;
  await user.save();

  const token = generateToken(res, user._id, user.role);

  res.json({ user: await serializeUser(user), token });
});

// POST /api/auth/resend-otp
const resendOtp = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ message: 'Email is required' });
  }

  const user = await User.findOne({ email });
  if (!user) {
    return res.status(404).json({ message: 'No account found for this email' });
  }
  if (user.isEmailVerified) {
    return res.status(400).json({ message: 'This email is already verified' });
  }

  const otp = generateOtp();
  await user.setEmailOtp(otp);
  await user.save();
  await sendOtpEmail(user.email, otp);

  res.json({
    message: 'A new verification code has been sent',
    ...(isEmailConfigured ? {} : { devOtp: otp }),
  });
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

  if (!user.isEmailVerified) {
    return res.status(403).json({ pendingVerification: true, email: user.email, message: 'Please verify your email to continue' });
  }

  const token = generateToken(res, user._id, user.role);

  res.json({ user: await serializeUser(user), token });
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
    // Google already verified this email address, so there's no OTP step
    // for these accounts — isEmailVerified keeps its schema default (true).
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

  const token = generateToken(res, user._id, user.role);

  res.json({ user: await serializeUser(user), token });
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

// PATCH /api/auth/me — name/phone only. Email is deliberately not editable
// here: it's the login identity (and unique-indexed), changing it needs its
// own verification flow which doesn't exist yet, so that's out of scope.
const updateMe = asyncHandler(async (req, res) => {
  const { name, phone } = req.body;

  if (name !== undefined) {
    if (!name.trim()) {
      return res.status(400).json({ message: 'Name cannot be empty' });
    }
    req.user.name = name.trim();
  }

  if (phone !== undefined) {
    req.user.phone = phone.trim();
  }

  await req.user.save();
  res.json({ user: await serializeUser(req.user) });
});

module.exports = { register, login, verifyOtp, resendOtp, googleAuth, logout, getMe, updateMe };
