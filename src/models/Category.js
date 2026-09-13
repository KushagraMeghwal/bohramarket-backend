const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    description: String,
    image: {
      url: String,
      publicId: String,
    },
    parentCategory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      default: null,
    },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    // Drives whether products in this category get a size selector (clothing/
    // footwear/accessories) or not (food/other) on the product page and the
    // seller product form.
    type: {
      type: String,
      enum: ['clothing', 'footwear', 'accessories', 'food', 'other'],
      default: 'other',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Category', categorySchema);
