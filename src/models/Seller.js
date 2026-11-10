const mongoose = require('mongoose');
const { encrypt, mask } = require('../utils/fieldCrypto');

const documentSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['pan', 'gst', 'aadhaar', 'bank_proof', 'other'],
      required: true,
    },
    url: { type: String, required: true },
    publicId: { type: String, required: true },
    // 'private' documents are only viewable through a short-lived signed
    // link (see sellerController.getDocumentUrl); 'upload' marks legacy
    // documents uploaded publicly before this was fixed (migrated at boot).
    deliveryType: { type: String, enum: ['upload', 'private'], default: 'upload' },
    resourceType: { type: String, default: 'image' },
    format: String,
  },
  { timestamps: true }
);

const sellerSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    businessName: { type: String, required: true, trim: true },
    businessType: {
      type: String,
      enum: ['individual', 'partnership', 'pvt_ltd', 'other'],
      default: 'individual',
    },
    gstNumber: { type: String, trim: true },
    panNumber: { type: String, trim: true },
    aadhaarNumber: { type: String, trim: true },
    contactPhone: { type: String, required: true },
    pickupAddress: {
      line1: { type: String, required: true },
      line2: String,
      city: { type: String, required: true },
      state: { type: String, required: true },
      pincode: { type: String, required: true },
      country: { type: String, default: 'India' },
    },
    // Registered on seller approval (sellerController.approveSeller) and
    // re-registered whenever the pickup address changes (updateMyProfile) —
    // see shiprocket.service.js ensurePickupLocation(). Shiprocket's adhoc
    // order API references pickup addresses by this nickname, not raw
    // address fields.
    shiprocketPickupLocationName: String,
    // Lets the seller/admin UI show *why* a seller's shipments would fail
    // before an order ever gets to them, instead of only surfacing the
    // problem the first time a real order silently fails Shiprocket's
    // /settings/company/addpickup call.
    shiprocketPickupStatus: {
      type: String,
      enum: ['not_registered', 'registered', 'failed'],
      default: 'not_registered',
    },
    shiprocketPickupError: String,
    shiprocketPickupRegisteredAt: Date,
    bankDetails: {
      accountHolderName: String,
      accountNumber: String,
      ifscCode: String,
      bankName: String,
    },
    documents: [documentSchema],
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'suspended'],
      default: 'pending',
    },
    rejectionReason: String,
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    ratingAverage: { type: Number, default: 0 },
    totalOrders: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Aadhaar and bank account numbers are stored encrypted (AES-256-GCM, see
// utils/fieldCrypto.js) and every JSON serialization masks them and drops
// document URLs. Code that genuinely needs the full values (admin KYC
// review) decrypts explicitly via sellerController.revealSensitive().
sellerSchema.pre('save', function encryptSensitiveFields() {
  if (this.isModified('aadhaarNumber') && this.aadhaarNumber) {
    this.aadhaarNumber = encrypt(this.aadhaarNumber);
  }
  if (this.isModified('bankDetails.accountNumber') && this.bankDetails?.accountNumber) {
    this.bankDetails.accountNumber = encrypt(this.bankDetails.accountNumber);
  }
});

sellerSchema.set('toJSON', {
  transform(doc, ret) {
    if (ret.aadhaarNumber) ret.aadhaarNumber = mask(ret.aadhaarNumber);
    if (ret.bankDetails?.accountNumber) ret.bankDetails.accountNumber = mask(ret.bankDetails.accountNumber);
    if (Array.isArray(ret.documents)) {
      ret.documents = ret.documents.map(({ _id, type, createdAt }) => ({ _id, type, createdAt }));
    }
    return ret;
  },
});

module.exports = mongoose.model('Seller', sellerSchema);
