const razorpay = require('../config/razorpay');
const { isRazorpayConfigured } = require('../config/env');
const { TERMINAL_ITEM_STATUSES } = require('../utils/orderStatus');
const notificationService = require('./notification.service');

// Real money-back for prepaid orders. Every path that cancels or takes back
// a paid item (customer cancel, seller reject, seller no-response timeout,
// unserviceable pincode, return delivered back to the seller, admin cancel)
// goes through refundItems(), which:
//   1. works out what is still refundable for those items (never twice —
//      item.refundedAmount/refundedAt is the guard),
//   2. adds the shipping fee once the whole order is cancelled before
//      anything shipped,
//   3. asks Razorpay to refund it and records the attempt on order.refunds.
// Callers own order.save().

const round2 = (n) => Math.round(n * 100) / 100;

// The Razorpay SDK rejects with plain objects ({ statusCode, error: {...} }),
// not Error instances — pull out something a human can act on.
function describeError(err) {
  if (!err) return 'Unknown error';
  if (err.error?.description) return err.error.description;
  if (typeof err.message === 'string' && err.message) return err.message;
  try {
    return JSON.stringify(err).slice(0, 300);
  } catch {
    return String(err);
  }
}

const isRefundable = (order) => order.paymentMethod === 'online' && order.paymentStatus === 'paid';

function shippingAlreadyRefunded(order) {
  return (order.refunds || []).some((r) => r.includesShipping && r.status !== 'failed');
}

// The shipping fee comes back only when nothing in the order will ever ship.
function shouldRefundShipping(order) {
  if (!order.shippingFee || shippingAlreadyRefunded(order)) return false;
  return order.items.every((item) => TERMINAL_ITEM_STATUSES.includes(item.itemStatus) && !item.shipment?.shippedAt);
}

function rollUpRefundStatus(order) {
  const refunds = order.refunds || [];
  const live = refunds.filter((r) => r.status !== 'failed');
  order.refundedAmount = round2(live.reduce((sum, r) => sum + r.amount, 0));
  const processed = round2(refunds.filter((r) => r.status === 'processed').reduce((sum, r) => sum + r.amount, 0));

  if (refunds.some((r) => r.status === 'failed')) {
    order.refundStatus = 'refund_failed';
  } else if (refunds.some((r) => r.status === 'pending')) {
    order.refundStatus = 'refund_pending';
  } else if (processed > 0 && processed >= round2(order.totalAmount)) {
    order.refundStatus = 'refunded';
    order.paymentStatus = 'refunded';
  } else if (processed > 0) {
    order.refundStatus = 'partially_refunded';
  }
}

async function callRazorpayRefund(order, refund) {
  if (!isRazorpayConfigured()) throw new Error('Razorpay is not configured on this server');
  if (!order.razorpay?.paymentId) throw new Error('Order has no Razorpay payment id to refund against');

  const response = await razorpay.payments.refund(order.razorpay.paymentId, {
    amount: Math.round(refund.amount * 100),
    speed: 'normal',
    notes: { orderNumber: order.orderNumber, reason: (refund.reason || '').slice(0, 250) },
  });
  refund.razorpayRefundId = response.id;
  refund.status = response.status === 'processed' ? 'processed' : 'pending';
  if (refund.status === 'processed') refund.processedAt = new Date();
  refund.error = undefined;
}

// Refunds the given items (already marked cancelled/returned by the caller).
// Returns the refund record, or null when nothing is owed (COD / unpaid
// order / items already refunded).
async function refundItems(order, items, { reason } = {}) {
  if (!isRefundable(order)) return null;

  const pendingItems = items.filter((item) => !item.refundedAt);
  let amount = pendingItems.reduce((sum, item) => sum + Math.max(0, item.subtotal - (item.refundedAmount || 0)), 0);
  const includesShipping = shouldRefundShipping(order);
  if (includesShipping) amount += order.shippingFee;

  const remaining = round2(order.totalAmount - (order.refundedAmount || 0));
  amount = round2(Math.min(amount, remaining));
  if (amount <= 0) return null;

  const now = new Date();
  pendingItems.forEach((item) => {
    item.refundedAmount = item.subtotal;
    item.refundedAt = now;
  });

  order.refunds.push({ amount, reason, includesShipping, itemIds: pendingItems.map((item) => item._id), status: 'pending' });
  const refund = order.refunds[order.refunds.length - 1];

  try {
    await callRazorpayRefund(order, refund);
    console.log(`[refund] order ${order.orderNumber}: Rs ${amount} refund ${refund.razorpayRefundId} (${refund.status})`);
    notificationService.notifyCustomer({ order, templateKey: 'REFUND_INITIATED', vars: { orderNumber: order.orderNumber } });
  } catch (err) {
    refund.status = 'failed';
    refund.error = describeError(err);
    console.error(`[refund] order ${order.orderNumber}: Rs ${amount} refund FAILED: ${refund.error}`);
    notificationService.notifyAdmin(`Refund of Rs ${amount} for order ${order.orderNumber} failed: ${refund.error}. Retry it from the admin panel.`);
  }

  rollUpRefundStatus(order);
  return refund;
}

// Admin "retry" for a refund Razorpay rejected (e.g. insufficient balance).
async function retryRefund(order, refundId) {
  const refund = order.refunds.id(refundId);
  if (!refund) throw Object.assign(new Error('Refund not found'), { statusCode: 404 });
  if (refund.status !== 'failed') throw Object.assign(new Error(`Refund is ${refund.status}, not failed`), { statusCode: 400 });

  try {
    await callRazorpayRefund(order, refund);
  } catch (err) {
    refund.error = describeError(err);
  }
  rollUpRefundStatus(order);
  return refund;
}

// Webhook side: refund.processed / refund.failed.
function applyRefundWebhook(order, razorpayRefund, status) {
  let refund = order.refunds.find((r) => r.razorpayRefundId === razorpayRefund.id);
  if (!refund) {
    // A refund issued straight from the Razorpay dashboard — record it so the
    // order's totals stay truthful.
    order.refunds.push({ razorpayRefundId: razorpayRefund.id, amount: round2((razorpayRefund.amount || 0) / 100), reason: 'Refunded via Razorpay dashboard', status: 'pending' });
    refund = order.refunds[order.refunds.length - 1];
  }
  refund.status = status;
  if (status === 'processed') refund.processedAt = new Date();
  rollUpRefundStatus(order);
  return refund;
}

module.exports = { refundItems, retryRefund, applyRefundWebhook, rollUpRefundStatus, shouldRefundShipping };
