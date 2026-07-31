const mongoose = require('mongoose');

const documentSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['pan', 'gst', 'aadhaar', 'bank_proof', 'other'],
      required: true,
    },
    url: { type: String, required: true },
    publicId: { type: String, required: true },
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
    // Registered lazily the first time this seller ships an order — see
    // shiprocket.service.js ensurePickupLocation(). Shiprocket's adhoc order
    // API references pickup addresses by this nickname, not raw address fields.
    shiprocketPickupLocationName: String,
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

module.exports = mongoose.model('Seller', sellerSchema);
