const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: 1 },
  },
  { timestamps: true }
);

const cartSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    items: [cartItemSchema],
    // TODO: guests get a frontend-only cart (no server record). When a guest
    // logs in, merge their local cart into this server-side cart here.
    // Not implemented yet.
  },
  { timestamps: true }
);

module.exports = mongoose.model('Cart', cartSchema);
