const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const addressSchema = new mongoose.Schema(
  {
    label: { type: String, default: 'Home' },
    fullName: { type: String, required: true },
    phone: { type: String, required: true },
    line1: { type: String, required: true },
    line2: String,
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
    country: { type: String, default: 'India' },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    // Not required for Google accounts (authProvider: 'google') — those users
    // never set a local password and sign in via Firebase ID token instead.
    password: {
      type: String,
      required: function passwordRequired() {
        return this.authProvider !== 'google';
      },
      select: false,
    },
    authProvider: { type: String, enum: ['local', 'google'], default: 'local' },
    googleId: { type: String, select: false, sparse: true, unique: true },
    phone: { type: String, trim: true },
    role: {
      type: String,
      enum: ['customer', 'seller', 'admin'],
      default: 'customer',
    },
    avatarUrl: String,
    addresses: [addressSchema],
    wishlist: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    isActive: { type: Boolean, default: true },
    // Defaults to true (not false) so accounts created before this field
    // existed, and accounts created any other way than the local-signup OTP
    // flow (Google sign-in, seed scripts), are never retroactively locked
    // out. `register` is the only place that explicitly sets this false.
    isEmailVerified: { type: Boolean, default: true },
    emailOtp: { type: String, select: false },
    emailOtpExpires: { type: Date, select: false },
  },
  { timestamps: true }
);

userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  // Google-only accounts have no local password to compare against.
  if (!this.password) return Promise.resolve(false);
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.setEmailOtp = async function setEmailOtp(otp) {
  this.emailOtp = await bcrypt.hash(otp, 10);
  this.emailOtpExpires = new Date(Date.now() + 10 * 60 * 1000);
};

userSchema.methods.compareEmailOtp = function compareEmailOtp(candidate) {
  if (!this.emailOtp || !this.emailOtpExpires) return Promise.resolve(false);
  if (this.emailOtpExpires.getTime() < Date.now()) return Promise.resolve(false);
  return bcrypt.compare(candidate, this.emailOtp);
};

module.exports = mongoose.model('User', userSchema);
