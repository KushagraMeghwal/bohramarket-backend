const mongoose = require('mongoose');

// One job = one step of one seller's shipment for one order. The chain
// (see fulfillment.service.js) is: ensure_pickup -> serviceability ->
// create_order -> assign_awb -> request_pickup -> generate_label ->
// generate_invoice. ensure_pickup is included even though it wasn't in the
// originally specified step list, because it's genuinely the chain's first
// step (PART 2.6 step 1) — leaving it out of the job-tracked steps would
// mean a pickup-registration failure never surfaces as a resumable/visible
// job, which defeats the point of this queue.
const STEPS = [
  'ensure_pickup',
  'serviceability',
  'create_order',
  'assign_awb',
  'request_pickup',
  'generate_label',
  'generate_invoice',
];

const shipmentJobSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true },
    step: { type: String, enum: STEPS, required: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'done', 'failed', 'needs_attention'],
      default: 'pending',
    },
    attempts: { type: Number, default: 0 },
    lastError: String,
    nextRetryAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// One active (non-done) job per order+seller+step — reprocessing an order
// re-uses/resets the existing job instead of piling up duplicates.
shipmentJobSchema.index({ order: 1, seller: 1, step: 1 }, { unique: true });
shipmentJobSchema.index({ status: 1, nextRetryAt: 1 });

module.exports = mongoose.model('ShipmentJob', shipmentJobSchema);
module.exports.STEPS = STEPS;
