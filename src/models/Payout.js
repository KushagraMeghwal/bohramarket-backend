const mongoose = require('mongoose');

const payoutSchema = new mongoose.Schema(
  {
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Seller',
      required: true,
    },
    orders: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],
    amount: { type: Number, required: true },
    commissionDeducted: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['pending', 'processing', 'paid', 'failed'],
      default: 'pending',
    },
    paymentReference: String,
    periodStart: Date,
    periodEnd: Date,
    paidAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model('Payout', payoutSchema);
