const crypto = require('crypto');
const Order = require('../models/Order');
const WebhookEvent = require('../models/WebhookEvent');
const { recalcOrderStatus, maybeStartReturnWindow, TERMINAL_ITEM_STATUSES } = require('../utils/orderStatus');
const { mapShiprocketStatus, summarizeFulfillment } = require('../config/shipmentStatus');
const notificationService = require('../services/notification.service');
const { refundItems, applyRefundWebhook } = require('../services/refund.service');
const { onOnlineOrderPaid } = require('../services/orderEvents.service');
const { isProduction } = require('../config/env');

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

  let eventRecord;
  try {
    eventRecord = await WebhookEvent.create({ razorpayEventId: idempotencyKey, eventType: event.event });
  } catch (err) {
    if (err.code === 11000) {
      console.log(`[razorpay webhook] duplicate delivery for ${idempotencyKey}, already processed — skipping`);
      return;
    }
    throw err;
  }

  console.log(`[razorpay webhook] processing ${idempotencyKey}`);

  try {
    switch (event.event) {
      case 'payment.captured':
        await handlePaymentCaptured(event.payload.payment.entity);
        break;
      case 'payment.failed':
        await handlePaymentFailed(event.payload.payment.entity);
        break;
      case 'order.paid':
        await handleOrderPaid(event.payload.order.entity, event.payload.payment?.entity);
        break;
      case 'refund.processed':
        await handleRefundEvent(event.payload.refund.entity, 'processed');
        break;
      case 'refund.failed':
        await handleRefundEvent(event.payload.refund.entity, 'failed');
        break;
      default:
        console.log(`[razorpay webhook] unhandled event type ${event.event}, ignoring`);
    }
  } catch (err) {
    // Release the idempotency key so Razorpay's next retry of this event is
    // processed instead of being skipped as a "duplicate" of a failed run.
    await WebhookEvent.deleteOne({ _id: eventRecord._id }).catch(() => {});
    throw err;
  }
}

// Shared by payment.captured and order.paid: the pending→paid transition,
// guarded so it happens once, and only for the exact amount we asked for.
async function markOrderPaid(order, payment) {
  if (order.paymentStatus === 'paid' || order.paymentStatus === 'refunded') {
    console.log(`[razorpay webhook] order ${order.orderNumber} already ${order.paymentStatus}, skipping`);
    return;
  }

  const expectedPaise = Math.round(order.totalAmount * 100);
  if (payment?.amount != null && Number(payment.amount) !== expectedPaise) {
    console.error(`[razorpay webhook] order ${order.orderNumber}: paid ${payment.amount} paise but expected ${expectedPaise} — not marking paid`);
    notificationService.notifyAdmin(`Order ${order.orderNumber}: Razorpay payment amount (${payment.amount / 100}) does not match order total (${order.totalAmount}). Check it manually.`);
    return;
  }

  order.razorpay = order.razorpay || {};
  if (payment) {
    order.razorpay.paymentId = payment.id;
    order.razorpay.method = payment.method;
    order.razorpay.capturedAt = new Date((payment.created_at || Date.now() / 1000) * 1000);
  }
  order.paymentStatus = 'paid';
  order.paidAt = new Date();

  if (order.orderStatus === 'cancelled') {
    // Paid after the payment window expired and the order was released —
    // send the money straight back.
    await refundItems(order, order.items, { reason: 'Payment received after the order expired' });
    await order.save();
    console.log(`[razorpay webhook] order ${order.orderNumber} was already cancelled — late payment refunded`);
    return;
  }

  await order.save();
  console.log(`[razorpay webhook] order ${order.orderNumber} marked paid (${payment?.id || 'order.paid'})`);
  onOnlineOrderPaid(order);
}

async function handlePaymentCaptured(payment) {
  const order = await Order.findOne({ 'razorpay.orderId': payment.order_id });
  if (!order) {
    console.warn(`[razorpay webhook] payment.captured for unknown razorpay order ${payment.order_id}`);
    return;
  }
  await markOrderPaid(order, payment);
}

async function handlePaymentFailed(payment) {
  const order = await Order.findOne({ 'razorpay.orderId': payment.order_id });
  if (!order) {
    console.warn(`[razorpay webhook] payment.failed for unknown razorpay order ${payment.order_id}`);
    return;
  }

  if (order.paymentStatus === 'paid' || order.paymentStatus === 'refunded') {
    console.log(`[razorpay webhook] order ${order.orderNumber} already ${order.paymentStatus}, ignoring stale payment.failed`);
    return;
  }

  order.razorpay = order.razorpay || {};
  order.razorpay.failureReason = payment.error_code;
  order.razorpay.failureDescription = payment.error_description;
  order.paymentStatus = 'failed';
  await order.save();

  console.log(`[razorpay webhook] order ${order.orderNumber} marked payment failed (${payment.error_code})`);
}

// Fires alongside payment.captured as a redundant confirmation; markOrderPaid
// makes the second one a no-op.
async function handleOrderPaid(razorpayOrder, payment) {
  const order = await Order.findOne({ 'razorpay.orderId': razorpayOrder.id });
  if (!order) {
    console.warn(`[razorpay webhook] order.paid for unknown razorpay order ${razorpayOrder.id}`);
    return;
  }
  await markOrderPaid(order, payment || { amount: razorpayOrder.amount_paid });
}

async function handleRefundEvent(refund, status) {
  const order =
    (await Order.findOne({ 'refunds.razorpayRefundId': refund.id })) ||
    (await Order.findOne({ 'razorpay.paymentId': refund.payment_id }));
  if (!order) {
    console.warn(`[razorpay webhook] refund.${status} for unknown payment ${refund.payment_id}`);
    return;
  }

  applyRefundWebhook(order, refund, status);
  await order.save();

  console.log(`[razorpay webhook] order ${order.orderNumber}: refund ${refund.id} ${status} (order refundStatus=${order.refundStatus})`);
  if (status === 'failed') {
    notificationService.notifyAdmin(`Refund ${refund.id} for order ${order.orderNumber} FAILED at Razorpay. Retry it from the admin panel.`);
  }
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
  // Fail closed: in production an unset token means every call is
  // rejected (previously it meant every call was *accepted*, so anyone could
  // post a fake "Delivered" for any AWB). Outside production an unset token
  // is allowed so the flow can be exercised locally.
  const expectedToken = process.env.SHIPROCKET_WEBHOOK_TOKEN;
  if (!expectedToken && isProduction) {
    console.error('[shiprocket webhook] rejected: SHIPROCKET_WEBHOOK_TOKEN is not configured');
    return res.status(401).json({ message: 'Invalid webhook token' });
  }
  if (expectedToken) {
    const provided = Buffer.from(String(req.headers['x-api-key'] || ''), 'utf8');
    const expected = Buffer.from(expectedToken, 'utf8');
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
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
  const returnedItems = []; // items whose return just arrived back at the seller — refunded below
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

        // A return arriving back at the seller is what triggers the refund.
        if (resolvedSellerStatus === 'return_delivered') {
          returnedItems.push(item);
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

  if (returnedItems.length) {
    const stillOut = order.items.some((item) => ['return_requested', 'return_picked'].includes(item.sellerOrderStatus));
    if (!stillOut && order.returnStatus === 'requested') order.returnStatus = 'completed';
    await refundItems(order, returnedItems, { reason: 'Return received by seller' });
  }
  await order.save();

  const summary = summarizeFulfillment(order.items);
  console.log(`[shiprocket webhook] order ${order.orderNumber} updated: courierStatus="${status}" | fulfillment summary: ${JSON.stringify(summary)}`);

  newlyReachedStatuses.forEach(({ templateKey }) => {
    notificationService.notifyCustomer({
      order,
      templateKey,
      vars: { orderNumber: order.orderNumber, awbNumber: awb, trackingUrl: awb ? `https://shiprocket.co/tracking/${awb}` : undefined },
    });
  });

  if (returnedItems.length && order.paymentMethod === 'COD') {
    notificationService.notifyAdmin(`Order ${order.orderNumber}: COD return received by the seller — refund the customer manually and mark it refunded.`);
  }
}

module.exports = { handleRazorpayWebhook, handleShiprocketWebhook };
