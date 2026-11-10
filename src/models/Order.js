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
    // Named awbNumber (not Shiprocket's own "awb_code") — this field was
    // already in use across the app (order-detail-page.ts, webhookController.js,
    // admin-orders.html) before this round of changes; adding a second,
    // differently-named AWB field would just create two sources of truth for
    // the same value, which is exactly what the new statusHistory/roll-up
    // work below is trying to avoid elsewhere.
    awbNumber: String,
    courierName: String,
    // Shiprocket's numeric courier_company_id — needed to call assignAwb()
    // with a specific courier rather than letting Shiprocket auto-pick one.
    courierId: String,
    trackingUrl: String,
    labelUrl: String,
    invoiceUrl: String,
    manifestUrl: String,
    pickupScheduledDate: Date,
    // Actual Shiprocket-quoted rate/ETA for this specific shipment, captured
    // at courier-selection time (see courierSelection.service.js) — distinct
    // from the flat checkout-time estimate shown to the customer.
    shippingRate: Number,
    estimatedDeliveryDays: Number,
    codCharges: Number,
    // Human-readable justification for courierSelection.service.js's pick
    // (rate/days/rating it compared, and which strategy was active) — kept
    // as free text rather than structured fields since this exists purely
    // for debugging "why did we ship via X instead of Y", not for querying.
    courierSelectionReason: String,
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
    // Verbatim status string from Shiprocket's tracking webhook/API — kept
    // separate from shipmentStatus above (which drives this app's own
    // fulfillment state machine) so raw courier text never has to be forced
    // into that constrained enum.
    courierStatus: String,
    shippedAt: Date,
    deliveredAt: Date,
  },
  { _id: false }
);

// One history entry per status transition, per item — used for the seller/
// admin timeline UI and for making webhook processing idempotent (a replayed
// webhook that would produce an identical latest entry is a no-op, see
// webhookController.js).
const statusHistoryEntrySchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    at: { type: Date, default: Date.now },
    source: { type: String, enum: ['webhook', 'seller', 'admin', 'system'], required: true },
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
    size: String, // snapshot of product.attributes.size, for clothing/footwear/accessories
    price: { type: Number, required: true }, // snapshot
    quantity: { type: Number, required: true, min: 1 },
    subtotal: { type: Number, required: true },
    itemStatus: {
      type: String,
      enum: ['placed', 'packed', 'shipped', 'delivered', 'cancelled', 'rto'],
      default: 'placed',
    },
    // Fine-grained per-seller fulfillment state (seller acceptance, courier
    // milestones, return legs). Kept as a field on the existing per-item
    // subdocument rather than a separate top-level `sellerOrders[]` array:
    // an order item is already scoped to exactly one seller (item.seller),
    // so a parallel array would just be items re-grouped by seller with its
    // own id space to keep in sync — two collections tracking the same
    // "this seller's slice of this order" concept is a sync bug waiting to
    // happen. itemStatus above stays as the coarse, backward-compatible
    // status the rest of the app (recalcOrderStatus, existing UI) already
    // reads; sellerOrderStatus is the new detailed state machine this
    // feature adds. See statusMapping's rollUpItemStatus for how the two
    // relate.
    sellerOrderStatus: {
      type: String,
      enum: [
        'awaiting_seller',
        'accepted',
        'rejected',
        'confirmed',
        'ready_to_ship',
        'picked_up',
        'in_transit',
        'out_for_delivery',
        'delivered',
        'cancelled',
        'rto_initiated',
        'rto_delivered',
        'return_requested',
        'return_picked',
        'return_delivered',
      ],
      default: 'awaiting_seller',
    },
    sellerRespondedAt: Date,
    sellerRejectReason: String,
    statusHistory: [statusHistoryEntrySchema],
    shipment: shipmentSchema,
    // Reverse-leg (customer -> seller) shipment tracking for a return —
    // deliberately a separate field from `shipment` above (not reused/
    // overwritten), since a return has its own AWB/courier/tracking history
    // that must not clobber the original forward delivery's record. Reuses
    // shipmentSchema's shape since the fields it tracks (awbNumber,
    // courierName, shipmentStatus, etc.) are identical in kind, just for the
    // opposite direction.
    returnShipment: shipmentSchema,
    // Set once this item's money has been refunded (or a Razorpay refund
    // requested for it) so no code path can refund the same item twice.
    refundedAmount: { type: Number, default: 0 },
    refundedAt: Date,
  },
  { timestamps: true }
);

const refundSchema = new mongoose.Schema(
  {
    razorpayRefundId: String,
    amount: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'processed', 'failed'], default: 'pending' },
    reason: String,
    itemIds: [mongoose.Schema.Types.ObjectId],
    includesShipping: { type: Boolean, default: false },
    error: String,
    processedAt: Date,
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
      enum: ['none', 'refund_pending', 'partially_refunded', 'refunded', 'refund_failed'],
      default: 'none',
    },
    // One entry per Razorpay refund request. refundStatus above is the
    // roll-up of these (see refund.service.js).
    refunds: [refundSchema],
    refundedAmount: { type: Number, default: 0 },
    paidAt: Date,
    // Set once, when the order first reaches orderStatus 'delivered' (7 days
    // out from that moment). One window for the whole order — items across
    // sellers can still ship/deliver at different times, but this is
    // intentionally simple rather than tracking a return window per item.
    returnEligibleUntil: Date,
    returnStatus: {
      type: String,
      enum: ['none', 'requested', 'approved', 'rejected', 'completed'],
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
