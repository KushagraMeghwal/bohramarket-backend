const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
    },
    rating: { type: Number, required: true, min: 1, max: 5 },
    title: String,
    comment: { type: String, required: true },
    images: [{ url: String, publicId: String }],
    sellerReply: {
      text: String,
      repliedAt: Date,
    },
  },
  { timestamps: true }
);

// One review per purchased item, keeps reviews tied to verified purchases
reviewSchema.index({ product: 1, customer: 1, order: 1 }, { unique: true });

module.exports = mongoose.model('Review', reviewSchema);
