const crypto = require('crypto');
const Order = require('../models/Order');
const WebhookEvent = require('../models/WebhookEvent');
const { createShipmentForOrder } = require('../services/orderFulfillment.service');
const { recalcOrderStatus, maybeStartReturnWindow, TERMINAL_ITEM_STATUSES } = require('../utils/orderStatus');

// Pulls the Razorpay entity id relevant to this event type — used to build a
// stable idempotency key, since Razorpay does not guarantee a distinct
// event-id on every delivery but does resend the identical payload on retry.
const eventEntityId = (event) => {
  const payload = event.payload || {};
  if (payload.payment?.entity) return payload.payment.entity.id;
  if (payload.order?.entity) return payload.order.entity.id;
  if (payload.refund?.entity) return payload.refund.entity.id;
  return null;
};

// POST /api/webhooks/razorpay
// Mounted with express.raw() (see server.js) so req.body is the untouched
// Buffer Razorpay signed — HMAC verification fails silently against a body
// that's been through JSON.parse/stringify, since key order and whitespace
// aren't guaranteed to round-trip identically.
const handleRazorpayWebhook = async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.body;

  if (!signature || !Buffer.isBuffer(rawBody)) {
    console.warn('[razorpay webhook] rejected: missing signature header or non-raw body');
    return res.status(400).json({ message: 'Invalid webhook request' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  const signatureBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

  const isValid =
    signatureBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(signatureBuffer, expectedBuffer);

  if (!isValid) {
    console.warn('[razorpay webhook] rejected: signature mismatch');
    return res.status(400).json({ message: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.warn('[razorpay webhook] rejected: malformed JSON body', err.message);
    return res.status(400).json({ message: 'Malformed JSON' });
  }

  console.log(`[razorpay webhook] signature valid, event=${event.event}`);

  // Ack immediately — Razorpay retries aggressively (and eventually disables
  // the webhook) if it doesn't see a fast 2xx, so DB work happens after the
  // response is already on the wire.
  res.status(200).json({ received: true });

  processRazorpayEvent(event).catch((err) => {
    console.error(`[razorpay webhook] processing failed for event=${event?.event}`, err);
  });
};

async function processRazorpayEvent(event) {
  const entityId = eventEntityId(event);
  if (!entityId) {
    console.warn(`[razorpay webhook] event=${event.event} has no recognizable entity id, skipping`);
    return;
  }

  const idempotencyKey = `${event.event}:${entityId}`;

  try {
    await WebhookEvent.create({ razorpayEventId: idempotencyKey, eventType: event.event });
  } catch (err) {
    if (err.code === 11000) {
      console.log(`[razorpay webhook] duplicate delivery for ${idempotencyKey}, already processed — skipping`);
      return;
    }
    throw err;
  }

  console.log(`[razorpay webhook] processing ${idempotencyKey}`);

  switch (event.event) {
    case 'payment.captured':
      await handlePaymentCaptured(event.payload.payment.entity);
      break;
    case 'payment.failed':
      await handlePaymentFailed(event.payload.payment.entity);
      break;
    case 'order.paid':
      await handleOrderPaid(event.payload.order.entity);
      break;
    case 'refund.processed':
      await handleRefundProcessed(event.payload.refund.entity);
      break;
    default:
      console.log(`[razorpay webhook] unhandled event type ${event.event}, ignoring`);
  }
}

async function handlePaymentCaptured(payment) {
  const order = await Order.findOne({ 'razorpay.orderId': payment.order_id });
  if (!order) {
    console.warn(`[razorpay webhook] payment.captured for unknown razorpay order ${payment.order_id}`);
    return;
  }

  if (order.paymentStatus === 'paid') {
    console.log(`[razorpay webhook] order ${order.orderNumber} already paid, skipping payment.captured`);
    return;
  }

  order.razorpay = order.razorpay || {};
  order.razorpay.orderId = payment.order_id;
  order.razorpay.paymentId = payment.id;
  order.razorpay.method = payment.method;
  order.razorpay.capturedAt = new Date((payment.created_at || Date.now() / 1000) * 1000);
  order.paymentStatus = 'paid';
  await order.save();

  console.log(`[razorpay webhook] order ${order.orderNumber} marked paid via payment.captured (${payment.id})`);

  // Not awaited — see createShipmentForOrder's own comment. This is the
  // authoritative trigger for online orders (the frontend's verifyPayment
  // call is a secondary, redundant one — see orderController.js); the
  // idempotency check inside createShipmentForOrder covers whichever fires second.
  createShipmentForOrder(order);

  // Cart clearing: CartService.checkout() on the frontend already clears the
  // cart right after order creation (before payment even starts), so there's
  // nothing left to clear here — see cart.service.ts.
  //
  // Order-confirmation email/notification: no such service exists anywhere
  // in this codebase yet, so there's nothing to hook into.
  //
  // Multi-vendor seller-split: Order.items[].itemStatus tracks per-item
  // FULFILLMENT progress (placed/packed/shipped/...), not payment — payment
  // is only ever tracked at the parent Order level, so there is no
  // per-seller payment field to update even when items span sellers.
}

async function handlePaymentFailed(payment) {
  const order = await Order.findOne({ 'razorpay.orderId': payment.order_id });
  if (!order) {
    console.warn(`[razorpay webhook] payment.failed for unknown razorpay order ${payment.order_id}`);
    return;
  }

  if (order.paymentStatus === 'paid') {
    console.log(`[razorpay webhook] order ${order.orderNumber} already paid, ignoring stale payment.failed`);
    return;
  }

  order.razorpay = order.razorpay || {};
  order.razorpay.orderId = payment.order_id;
  order.razorpay.paymentId = payment.id;
  order.razorpay.failureReason = payment.error_code;
  order.razorpay.failureDescription = payment.error_description;
  order.paymentStatus = 'failed';
  await order.save();

  console.log(`[razorpay webhook] order ${order.orderNumber} marked payment failed (${payment.error_code})`);
}

// Fires alongside payment.captured as a second, redundant confirmation for
// the same event — guarded purely by the paymentStatus check below so it
// never overwrites anything payment.captured (or a refund) already set.
async function handleOrderPaid(razorpayOrder) {
  const order = await Order.findOne({ 'razorpay.orderId': razorpayOrder.id });
  if (!order) {
    console.warn(`[razorpay webhook] order.paid for unknown razorpay order ${razorpayOrder.id}`);
    return;
  }

  if (order.paymentStatus === 'paid') return;

  order.paymentStatus = 'paid';
  await order.save();
  console.log(`[razorpay webhook] order ${order.orderNumber} marked paid via order.paid safety net`);
}

async function handleRefundProcessed(refund) {
  const order = await Order.findOne({ 'razorpay.paymentId': refund.payment_id });
  if (!order) {
    console.warn(`[razorpay webhook] refund.processed for unknown payment ${refund.payment_id}`);
    return;
  }

  // TODO: there's no dedicated Refund/Return model in this codebase — if
  // partial or multiple refunds per order are ever needed, add one keyed by
  // the Razorpay refund id (refund.id) instead of collapsing everything onto
  // the parent Order's single refundStatus field, which can only represent
  // one refund per order.
  order.refundStatus = 'refunded';
  order.paymentStatus = 'refunded';
  await order.save();

  console.log(`[razorpay webhook] order ${order.orderNumber} marked refunded (refund ${refund.id})`);
}

// POST /api/webhooks/shiprocket
// Shiprocket's webhook auth model is a static shared-secret header you
// choose yourself when registering the webhook in their dashboard — not an
// HMAC signature the way Razorpay's is. Verified against
// SHIPROCKET_WEBHOOK_TOKEN if that env var is set; if it isn't, verification
// is skipped (documented in .env.example) rather than hard-failing, since
// Shiprocket will still work without one configured, just without this check.
//
// NOTE: the field names read out of `body` below are transcribed from
// Shiprocket's public webhook docs, not confirmed against a live delivery in
// this change. The console.log below prints the full raw payload on every
// call specifically so the very first real delivery can be used to verify
// (or correct) these field names.
const handleShiprocketWebhook = (req, res) => {
  const expectedToken = process.env.SHIPROCKET_WEBHOOK_TOKEN;
  if (expectedToken) {
    const providedToken = req.headers['x-api-key'];
    if (providedToken !== expectedToken) {
      console.warn('[shiprocket webhook] rejected: token mismatch');
      return res.status(401).json({ message: 'Invalid webhook token' });
    }
  }

  const body = req.body || {};
  console.log('[shiprocket webhook] received', JSON.stringify(body));

  // Ack immediately, same reasoning as the Razorpay handler above.
  res.status(200).json({ received: true });

  processShiprocketWebhook(body).catch((err) => {
    console.error('[shiprocket webhook] processing failed', err);
  });
};

async function processShiprocketWebhook(body) {
  const awb = body.awb || body.awb_code;
  const shiprocketOrderId = body.order_id != null ? String(body.order_id) : body.sr_order_id != null ? String(body.sr_order_id) : undefined;
  const shiprocketShipmentId = body.shipment_id != null ? String(body.shipment_id) : undefined;
  const status = body.current_status || body.shipment_status || body.status;

  if (!awb && !shiprocketOrderId && !shiprocketShipmentId) {
    console.warn('[shiprocket webhook] payload has no recognizable identifier, ignoring', body);
    return;
  }

  const orConditions = [];
  if (awb) orConditions.push({ 'items.shipment.awbNumber': awb });
  if (shiprocketOrderId) orConditions.push({ 'items.shipment.shiprocketOrderId': shiprocketOrderId });
  if (shiprocketShipmentId) orConditions.push({ 'items.shipment.shiprocketShipmentId': shiprocketShipmentId });

  const order = await Order.findOne({ $or: orConditions });
  if (!order) {
    console.warn('[shiprocket webhook] no matching order for', { awb, shiprocketOrderId, shiprocketShipmentId });
    return;
  }

  let touched = false;
  order.items.forEach((item) => {
    const matches =
      (awb && item.shipment?.awbNumber === awb) ||
      (shiprocketOrderId && item.shipment?.shiprocketOrderId === shiprocketOrderId) ||
      (shiprocketShipmentId && item.shipment?.shiprocketShipmentId === shiprocketShipmentId);
    if (!matches) return;

    item.shipment = item.shipment || {};
    item.shipment.courierStatus = status;
    if (awb && !item.shipment.awbNumber) item.shipment.awbNumber = awb;

    const normalized = (status || '').toLowerCase();
    if (normalized.includes('delivered')) {
      item.shipment.shipmentStatus = 'delivered';
      item.shipment.deliveredAt = item.shipment.deliveredAt || new Date();
      if (!TERMINAL_ITEM_STATUSES.includes(item.itemStatus)) item.itemStatus = 'delivered';
    } else if (normalized.includes('out for delivery') || normalized.includes('transit')) {
      item.shipment.shipmentStatus = 'in_transit';
    } else if (normalized.includes('rto') && normalized.includes('deliver')) {
      item.shipment.shipmentStatus = 'rto_delivered';
    } else if (normalized.includes('rto')) {
      item.shipment.shipmentStatus = 'rto_initiated';
    }

    touched = true;
  });

  if (!touched) return;

  recalcOrderStatus(order);
  maybeStartReturnWindow(order);
  await order.save();

  console.log(`[shiprocket webhook] order ${order.orderNumber} updated: courierStatus="${status}"`);
}

module.exports = { handleRazorpayWebhook, handleShiprocketWebhook };
