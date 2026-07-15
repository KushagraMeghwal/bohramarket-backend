const mongoose = require('mongoose');

// Dedupe key for a Razorpay webhook delivery. Razorpay does not guarantee a
// stable event-id header on every payload, so callers derive this from
// `${event.event}:${entityId}` (see webhookController) which is stable across
// retries of the same delivery.
const webhookEventSchema = new mongoose.Schema(
  {
    razorpayEventId: { type: String, required: true, unique: true },
    eventType: { type: String, required: true },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('WebhookEvent', webhookEventSchema);
