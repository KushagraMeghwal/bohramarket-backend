const mongoose = require('mongoose');

// Dedupe key for a Razorpay webhook delivery. Razorpay does not guarantee a
// stable event-id header on every payload, so callers derive this from
// `${event.event}:${entityId}` (see webhookController) which is stable across
// retries of the same delivery.
const webhookEventSchema = new mongoose.Schema(
  {
    // sparse (not required) so a Shiprocket-only document can omit this —
    // Razorpay's own handler still always sets it, unchanged.
    razorpayEventId: { type: String, unique: true, sparse: true },
    // Dedupe key for a Shiprocket webhook delivery — see
    // webhookController.js's shiprocketDedupeKey(). A separate field (not a
    // reuse/rename of razorpayEventId) so both webhook sources share this
    // one idempotency table without either one's key format constraining
    // the other.
    shiprocketEventId: { type: String, unique: true, sparse: true },
    eventType: { type: String, required: true },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('WebhookEvent', webhookEventSchema);
