const User = require('../models/User');
const Seller = require('../models/Seller');
const asyncHandler = require('../utils/asyncHandler');
const { generateToken, TOKEN_COOKIE_NAME, COOKIE_OPTIONS } = require('../utils/generateToken');
const { verifyFirebaseIdToken } = require('../utils/verifyFirebaseToken');
const { sendOtpEmail, sendPasswordResetOtpEmail, isConfigured: isEmailConfigured } = require('../utils/mailer');

const crypto = require('crypto');
const { isProduction } = require('../config/env');

const generateOtp = () => String(crypto.randomInt(100000, 1000000));

// Returning the code in the API response is a local-development convenience
// only. In production it would let anyone reset any account's password
// (this was live: production had no SMTP, so /forgot-password handed the
// reset code to whoever asked). Production without SMTP refuses instead.
const exposeDevOtp = !isProduction && !isEmailConfigured;
const emailUnavailable = isProduction && !isEmailConfigured;
const EMAIL_UNAVAILABLE_MESSAGE = 'Email verification is temporarily unavailable. Please sign in with Google or try again later.';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

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
  const { name, password, phone } = req.body;
  const email = normalizeEmail(req.body.email);

  if (emailUnavailable) {
    return res.status(503).json({ message: EMAIL_UNAVAILABLE_MESSAGE });
  }
  if (!name || typeof name !== 'string' || !name.trim() || !email || !password) {
    return res.status(400).json({ message: 'Name, email and password are required' });
  }
  if (!EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ message: 'Enter a valid email address' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters' });
  }


  const existing = await User.findOne({ email });
  if (existing) {
    return res.status(409).json({ message: 'Email already registered' });
  }

  const user = await User.create({
    name: name.trim(),
    email,
    password,
    phone: typeof phone === 'string' ? phone.trim() : undefined,
    // Every new account starts as a customer, whatever the sign-up form's
    // buy/sell toggle said — submitting a seller application (with KYC) is
    // what turns it into a seller (sellerController.applySeller).
    role: 'customer',
    isEmailVerified: false,
  });

  const otp = generateOtp();
  await user.setEmailOtp(otp);
  await user.save();
  await sendOtpEmail(user.email, otp);

  // No token/cookie yet — the account exists but can't log in until the OTP
  // is verified (see verifyOtp below), so the frontend must route straight
  // to the "enter the code we emailed you" step instead of into the app.
  // devOtp is only included on a non-production server with no SMTP (see
  // exposeDevOtp above), so local testing can verify without an inbox.
  res.status(201).json({
    pendingVerification: true,
    email: user.email,
    message: 'We sent a verification code to your email',
    ...(exposeDevOtp ? { devOtp: otp } : {}),
  });
});

// POST /api/auth/verify-otp — completes registration (or a login blocked by
// an unverified email) once the user supplies the code emailed to them.
const verifyOtp = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ message: 'Email and OTP are required' });
  }

  const user = await User.findOne({ email }).select('+emailOtp +emailOtpExpires +emailOtpAttempts');
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
  const email = normalizeEmail(req.body.email);
  if (emailUnavailable) {
    return res.status(503).json({ message: EMAIL_UNAVAILABLE_MESSAGE });
  }
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
    ...(exposeDevOtp ? { devOtp: otp } : {}),
  });
});

// POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;

  if (!email || !password || typeof password !== 'string') {
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
  // Linking to an existing account by email is only safe when the identity
  // provider has verified that address.
  if (decoded.email_verified === false) {
    return res.status(401).json({ message: 'Your Google email address is not verified' });
  }
  decoded.email = normalizeEmail(decoded.email);

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

// POST /api/auth/forgot-password
// Body: { email }. Always responds with the same generic message regardless
// of whether the account exists (or is Google-only, which has no local
// password to reset) — revealing which emails have accounts here is a real
// enumeration risk, unlike resend-otp above (that's mid-registration, where
// the caller already knows the account was just created).
const forgotPassword = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (emailUnavailable) {
    return res.status(503).json({ message: EMAIL_UNAVAILABLE_MESSAGE });
  }
  if (!email) {
    return res.status(400).json({ message: 'Email is required' });
  }

  const user = await User.findOne({ email });
  let devOtp;

  if (user && user.authProvider !== 'google') {
    const otp = generateOtp();
    await user.setPasswordResetOtp(otp);
    await user.save();
    await sendPasswordResetOtpEmail(user.email, otp);
    if (exposeDevOtp) devOtp = otp;
  }

  res.json({
    message: 'If an account exists for this email, a reset code has been sent.',
    ...(devOtp ? { devOtp } : {}),
  });
});

// POST /api/auth/reset-password
// Body: { email, otp, newPassword }
const resetPassword = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { otp, newPassword } = req.body;
  if (!email || !otp || !newPassword) {
    return res.status(400).json({ message: 'Email, code and new password are required' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters' });
  }

  const user = await User.findOne({ email }).select('+passwordResetOtp +passwordResetOtpExpires +passwordResetOtpAttempts');
  if (!user || !(await user.comparePasswordResetOtp(otp))) {
    return res.status(400).json({ message: 'Invalid or expired code' });
  }

  user.password = newPassword; // pre('save') hashes it
  user.passwordResetOtp = undefined;
  user.passwordResetOtpExpires = undefined;
  await user.save();

  res.json({ message: 'Password updated. You can now log in with your new password.' });
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
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ message: 'Name cannot be empty' });
    }
    req.user.name = name.trim();
  }

  if (phone !== undefined) {
    const trimmed = typeof phone === 'string' ? phone.trim() : '';
    if (trimmed && !/^[6-9]\d{9}$/.test(trimmed)) {
      return res.status(400).json({ message: 'Enter a valid 10-digit mobile number' });
    }
    req.user.phone = trimmed;
  }

  await req.user.save();
  res.json({ user: await serializeUser(req.user) });
});

module.exports = { register, login, verifyOtp, resendOtp, googleAuth, logout, getMe, updateMe, forgotPassword, resetPassword };
