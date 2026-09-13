const crypto = require('crypto');
const Order = require('../models/Order');
const WebhookEvent = require('../models/WebhookEvent');
const { recalcOrderStatus, maybeStartReturnWindow, TERMINAL_ITEM_STATUSES } = require('../utils/orderStatus');
const { mapShiprocketStatus, summarizeFulfillment } = require('../config/shipmentStatus');
const notificationService = require('../services/notification.service');

// SMS fires only for status TEXT that actually maps to one of these
// sellerOrderStatus values, and only once per real transition into it (see
// processShiprocketWebhook) — not on every scan Shiprocket sends. RTO has no
// matching customer template among the 9 keys given (PART 2.7's list is
// forward-shipment-phrased) — deliberately not reusing CANCELLED for it
// since "cancelled" and "returned to origin" mean different things to a
// customer; flagged here rather than sending a misleading message.
const MILESTONE_SMS_TEMPLATE = {
  picked_up: 'SHIPPED',
  out_for_delivery: 'OUT_FOR_DELIVERY',
  delivered: 'DELIVERED',
};

// Return-leg (reverse shipment) equivalent of the map above. No entry for
// "delivered" here on purpose — a return arriving back at the seller has no
// dedicated customer template among PART 2.7's 9 keys; REFUND_INITIATED
// (sent separately below, only when a refund is actually triggered) is the
// customer-relevant follow-up instead of a redundant "delivered" message.
const RETURN_MILESTONE_SMS_TEMPLATE = {
  picked_up: 'RETURN_PICKED',
};

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

  // No longer auto-fires fulfillment here (or from orderController's
  // verifyPayment — see that file's comment): items already sit in
  // sellerOrderStatus 'awaiting_seller' from order creation, and now wait
  // for each seller to explicitly accept before anything ships. Payment
  // confirmation only unblocks the accept action's own payment-status guard
  // (sellerOrderActionController.acceptSellerItem) — it doesn't trigger
  // anything by itself.
  // Their items were sitting in 'awaiting_seller' since creation but
  // couldn't actually be accepted (acceptSellerItem's payment-status guard)
  // until this exact moment — worth a nudge now that they can act on it.
  const notifiedSellers = new Set();
  order.items.forEach((item) => {
    const sellerId = String(item.seller);
    if (notifiedSellers.has(sellerId)) return;
    notifiedSellers.add(sellerId);
    notificationService.notifySeller(sellerId, `Payment confirmed for order ${order.orderNumber} — you can now accept this order`);
  });

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
// (PART 2.8 confirms this check was already present and working — it's
// unchanged here, just re-verified rather than assumed.)
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

// Dedupe key for a Shiprocket delivery. Shiprocket retries webhooks like
// Razorpay does, but (per the docs available) doesn't guarantee a distinct
// delivery/event id the way Razorpay's payloads at least contain a stable
// entity id — so this is built from the fields we do have: whichever
// shipment identifier matched, the raw status text, and whatever
// timestamp-shaped field the payload happens to carry. If Shiprocket sends
// no timestamp at all, two genuinely different real-world events with the
// identical status for the identical shipment would collapse into one — an
// accepted tradeoff (better to risk under-processing an ultra-rare case than
// to process every retry as a brand new event and duplicate history/SMS).
function shiprocketDedupeKey({ awb, shiprocketOrderId, shiprocketShipmentId, status, body }) {
  const idPart = awb || shiprocketShipmentId || shiprocketOrderId || 'unknown';
  const timePart = body.updated_at || body.current_timestamp || body.timestamp || body.awb_data?.updated_at || 'no-ts';
  return `${idPart}:${status}:${timePart}`;
}

async function processShiprocketWebhook(body) {
  const awb = body.awb || body.awb_code;
  const shiprocketOrderId = body.order_id != null ? String(body.order_id) : body.sr_order_id != null ? String(body.sr_order_id) : undefined;
  const shiprocketShipmentId = body.shipment_id != null ? String(body.shipment_id) : undefined;
  const status = body.current_status || body.shipment_status || body.status;

  if (!awb && !shiprocketOrderId && !shiprocketShipmentId) {
    console.warn('[shiprocket webhook] payload has no recognizable identifier, ignoring', body);
    return;
  }

  const dedupeKey = shiprocketDedupeKey({ awb, shiprocketOrderId, shiprocketShipmentId, status, body });
  try {
    await WebhookEvent.create({ shiprocketEventId: dedupeKey, eventType: `shiprocket:${status || 'unknown'}` });
  } catch (err) {
    if (err.code === 11000) {
      console.log(`[shiprocket webhook] duplicate delivery for ${dedupeKey}, already processed — skipping`);
      return;
    }
    throw err;
  }

  // Matched against both legs — a return shipment (PART 2.11) has its own
  // AWB/order/shipment ids on `returnShipment`, entirely separate from the
  // forward `shipment` a webhook might otherwise match.
  const orConditions = [];
  if (awb) orConditions.push({ 'items.shipment.awbNumber': awb }, { 'items.returnShipment.awbNumber': awb });
  if (shiprocketOrderId) {
    orConditions.push({ 'items.shipment.shiprocketOrderId': shiprocketOrderId }, { 'items.returnShipment.shiprocketOrderId': shiprocketOrderId });
  }
  if (shiprocketShipmentId) {
    orConditions.push(
      { 'items.shipment.shiprocketShipmentId': shiprocketShipmentId },
      { 'items.returnShipment.shiprocketShipmentId': shiprocketShipmentId }
    );
  }

  const order = await Order.findOne({ $or: orConditions });
  if (!order) {
    console.warn('[shiprocket webhook] no matching order for', { awb, shiprocketOrderId, shiprocketShipmentId });
    return;
  }

  const mapped = mapShiprocketStatus({ statusId: body.current_status_id, statusText: status });

  let touched = false;
  let refundJustTriggered = false;
  const newlyReachedStatuses = []; // { sellerOrderStatus, template } — for milestone SMS, only real transitions

  order.items.forEach((item) => {
    const forwardMatch =
      (awb && item.shipment?.awbNumber === awb) ||
      (shiprocketOrderId && item.shipment?.shiprocketOrderId === shiprocketOrderId) ||
      (shiprocketShipmentId && item.shipment?.shiprocketShipmentId === shiprocketShipmentId);

    const returnMatch =
      !forwardMatch &&
      ((awb && item.returnShipment?.awbNumber === awb) ||
        (shiprocketOrderId && item.returnShipment?.shiprocketOrderId === shiprocketOrderId) ||
        (shiprocketShipmentId && item.returnShipment?.shiprocketShipmentId === shiprocketShipmentId));

    if (!forwardMatch && !returnMatch) return;

    const leg = forwardMatch ? 'forward' : 'return';
    if (leg === 'forward') {
      item.shipment = item.shipment || {};
    } else {
      item.returnShipment = item.returnShipment || {};
    }
    const target = leg === 'forward' ? item.shipment : item.returnShipment;

    target.courierStatus = status;
    if (awb && !target.awbNumber) target.awbNumber = awb;

    if (mapped) {
      const previousSellerStatus = item.sellerOrderStatus;

      target.shipmentStatus = mapped.shipmentStatus;
      if (mapped.shipmentStatus === 'delivered') {
        target.deliveredAt = target.deliveredAt || new Date();
        if (leg === 'forward' && !TERMINAL_ITEM_STATUSES.includes(item.itemStatus)) item.itemStatus = 'delivered';
      }

      // Return-leg statuses map to different sellerOrderStatus values than
      // the same courier text means on a forward shipment — "Delivered" on
      // a return means it arrived back at the SELLER, not the customer.
      // rto_*/cancelled on a return leg has no defined equivalent in the
      // sellerOrderStatus enum — left as a no-op (logged) rather than
      // guessing a mapping PART 1 never specified.
      let resolvedSellerStatus = mapped.sellerOrderStatus;
      let smsTemplateKey;
      if (leg === 'return') {
        if (mapped.sellerOrderStatus === 'delivered') {
          resolvedSellerStatus = 'return_delivered';
        } else if (['picked_up', 'in_transit', 'out_for_delivery'].includes(mapped.sellerOrderStatus)) {
          resolvedSellerStatus = 'return_picked';
          smsTemplateKey = RETURN_MILESTONE_SMS_TEMPLATE.picked_up;
        } else {
          console.warn(
            `[shiprocket webhook] return-leg status "${mapped.sellerOrderStatus}" has no defined return-leg mapping for order ${order.orderNumber} — item left unchanged`
          );
          return;
        }
      } else {
        smsTemplateKey = MILESTONE_SMS_TEMPLATE[mapped.sellerOrderStatus];
      }

      // Only advance sellerOrderStatus forward, and only record history /
      // queue a milestone SMS if this is an actual transition — a repeated
      // webhook reporting the same status (a duplicate that slipped past
      // dedupe because Shiprocket sent no usable timestamp, or a second
      // distinct scan at the same status) must not append duplicate
      // history entries or re-send an SMS the customer already got.
      if (previousSellerStatus !== resolvedSellerStatus) {
        item.sellerOrderStatus = resolvedSellerStatus;
        item.statusHistory = item.statusHistory || [];
        item.statusHistory.push({ status: resolvedSellerStatus, source: 'webhook', at: new Date() });

        if (smsTemplateKey) {
          newlyReachedStatuses.push({ templateKey: smsTemplateKey });
        }

        // PART 2.11: a return arriving back at the seller is the trigger to
        // set refundStatus — same "record intent, no real gateway refund
        // call exists yet" pattern used everywhere else refundStatus is set
        // in this codebase (rejectAndSettleItem, handleRefundProcessed).
        if (
          resolvedSellerStatus === 'return_delivered' &&
          order.paymentMethod === 'online' &&
          order.paymentStatus === 'paid' &&
          order.refundStatus !== 'refunded'
        ) {
          order.refundStatus = 'refund_pending';
          refundJustTriggered = true;
        }
      }
    }

    touched = true;
  });

  if (!touched) return;

  // Parent-order roll-up: recalcOrderStatus (existing, itemStatus-driven)
  // keeps the persisted, enum-constrained Order.orderStatus field
  // consistent — unchanged, not rewritten. summarizeFulfillment (PART 2.8,
  // sellerOrderStatus-driven) gives the richer "partially_shipped" style
  // picture PART 1 asked for; logged for visibility rather than persisted
  // into a new field, since orderStatus's existing enum has real consumers
  // (order-detail-page.ts's step tracker) that a new value would break.
  recalcOrderStatus(order);
  maybeStartReturnWindow(order);
  await order.save();

  const summary = summarizeFulfillment(order.items);
  console.log(`[shiprocket webhook] order ${order.orderNumber} updated: courierStatus="${status}" | fulfillment summary: ${JSON.stringify(summary)}`);

  newlyReachedStatuses.forEach(({ templateKey }) => {
    notificationService.sendSms({
      to: order.shippingAddress?.phone,
      templateKey,
      vars: { orderNumber: order.orderNumber, awbNumber: awb, trackingUrl: awb ? `https://shiprocket.co/tracking/${awb}` : undefined },
    });
  });

  if (refundJustTriggered) {
    notificationService.sendSms({ to: order.shippingAddress?.phone, templateKey: 'REFUND_INITIATED', vars: { orderNumber: order.orderNumber } });
    notificationService.notifyAdmin(`Order ${order.orderNumber}: return delivered back to seller, refund marked pending`);
  }
}

module.exports = { handleRazorpayWebhook, handleShiprocketWebhook };
