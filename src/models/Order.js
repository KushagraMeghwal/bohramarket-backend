const mongoose = require('mongoose');

const addressSnapshotSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true },
    phone: { type: String, required: true },
    line1: { type: String, required: true },
    line2: String,
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
    country: { type: String, default: 'India' },
  },
  { _id: false }
);

// Shipment tracking lives per item (not on the order) because each seller
// in a multi-vendor order packs and ships their own items independently,
// each with its own AWB/courier.
const shipmentSchema = new mongoose.Schema(
  {
    awbNumber: String,
    courierName: String,
    trackingUrl: String,
    shipmentStatus: {
      type: String,
      enum: [
        'not_shipped',
        'shipped',
        'in_transit',
        'delivered',
        'rto_initiated',
        'rto_delivered',
      ],
      default: 'not_shipped',
    },
    shiprocketOrderId: String,
    shiprocketShipmentId: String,
    shippedAt: Date,
    deliveredAt: Date,
  },
  { _id: false }
);

const orderItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Seller',
      required: true,
    },
    name: { type: String, required: true }, // snapshot at time of order
    image: String, // snapshot
    price: { type: Number, required: true }, // snapshot
    quantity: { type: Number, required: true, min: 1 },
    subtotal: { type: Number, required: true },
    itemStatus: {
      type: String,
      enum: ['placed', 'packed', 'shipped', 'delivered', 'cancelled', 'rto'],
      default: 'placed',
    },
    shipment: shipmentSchema,
  },
  { timestamps: true }
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    items: [orderItemSchema],
    shippingAddress: { type: addressSnapshotSchema, required: true },
    itemsTotal: { type: Number, required: true },
    shippingFee: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true }, // server-calculated, never trust frontend
    paymentMethod: { type: String, enum: ['online', 'COD'], required: true },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    refundStatus: {
      type: String,
      enum: ['none', 'refund_pending', 'refunded'],
      default: 'none',
    },
    razorpay: {
      orderId: String,
      paymentId: String,
      signature: String,
      method: String, // upi | card | netbanking | wallet, from the captured payment entity
      capturedAt: Date,
      failureReason: String, // Razorpay's short error code (e.g. BAD_REQUEST_ERROR)
      failureDescription: String,
    },
    // Aggregate status derived from item statuses: the order is only as
    // advanced as its least-advanced non-terminal item (see recalcOrderStatus).
    orderStatus: {
      type: String,
      enum: ['placed', 'packed', 'shipped', 'delivered', 'cancelled', 'rto'],
      default: 'placed',
    },
    cancelReason: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model('Order', orderSchema);
