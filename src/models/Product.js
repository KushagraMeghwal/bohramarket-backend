const mongoose = require('mongoose');

const mediaSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String, required: true },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Seller',
      required: true,
    },
    name: { type: String, required: true, trim: true },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    description: { type: String, required: true },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
    },
    images: [mediaSchema],
    video: mediaSchema,
    price: { type: Number, required: true, min: 0 },
    discountPrice: { type: Number, min: 0 },
    sku: { type: String, required: true, unique: true, trim: true },
    stock: { type: Number, required: true, min: 0, default: 0 },
    // Each size/color combo is its own Product doc; variantGroupId links siblings
    // of the same design together so the frontend can offer "other sizes/colors".
    variantGroupId: { type: String, index: true },
    attributes: {
      size: String,
      color: String,
      material: String,
      fabric: String,
    },
    weight: Number, // kg, for Shiprocket rate calculation
    dimensions: {
      length: Number,
      width: Number,
      height: Number,
    },
    status: {
      type: String,
      enum: ['pending_review', 'active', 'rejected', 'inactive'],
      default: 'pending_review',
    },
    rejectionReason: String,
    isFeatured: { type: Boolean, default: false },
    ratingAverage: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    totalSold: { type: Number, default: 0 },
  },
  { timestamps: true }
);

productSchema.index({ name: 'text', description: 'text' });

module.exports = mongoose.model('Product', productSchema);
