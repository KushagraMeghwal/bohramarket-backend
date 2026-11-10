const Order = require('../models/Order');
const { rejectAndSettleItem } = require('./sellerItemSettlement.service');
const { startInterval } = require('../utils/scheduler');
const { PAYMENT_WINDOW_MINUTES } = require('../config/shop');
const notificationService = require('./notification.service');

const SELLER_RESPONSE_WINDOW_HOURS = Number(process.env.SELLER_RESPONSE_WINDOW_HOURS) || 24;
const CHECK_INTERVAL_MS = Number(process.env.SELLER_RESPONSE_CHECK_INTERVAL_MS) || 15 * 60 * 1000; // 15 min

// The seller's clock starts when the order becomes actionable for them: at
// placement for COD, at payment for online orders (they can't accept an
// unpaid order, so counting those hours against them was unfair).
const respondByFor = (order) =>
  new Date((order.paidAt || order.createdAt).getTime() + SELLER_RESPONSE_WINDOW_HOURS * 60 * 60 * 1000);

async function autoCancelUnansweredSellerItems() {
  const cutoff = new Date(Date.now() - SELLER_RESPONSE_WINDOW_HOURS * 60 * 60 * 1000);

  const orders = await Order.find({
    'items.sellerOrderStatus': 'awaiting_seller',
    $or: [
      { paymentMethod: 'COD', createdAt: { $lte: cutoff } },
      { paymentMethod: 'online', paymentStatus: 'paid', paidAt: { $lte: cutoff } },
      { paymentMethod: 'online', paymentStatus: 'paid', paidAt: { $exists: false }, createdAt: { $lte: cutoff } },
    ],
  });

  let cancelledItems = 0;

  for (const order of orders) {
    let touched = false;
    for (const item of order.items) {
      if (item.sellerOrderStatus === 'awaiting_seller') {
        await rejectAndSettleItem(order, item, {
          reason: `No response from seller within ${SELLER_RESPONSE_WINDOW_HOURS}h`,
          source: 'system',
        });
        touched = true;
        cancelledItems += 1;
      }
    }
    if (touched) {
      await order.save();
      notificationService.notifyAdmin(`Order ${order.orderNumber}: seller(s) did not respond within ${SELLER_RESPONSE_WINDOW_HOURS}h — item(s) auto-cancelled`);
    }
  }

  if (cancelledItems > 0) {
    console.log(`[seller-response-window] auto-cancelled ${cancelledItems} unanswered item(s) across ${orders.length} order(s)`);
  }

  return { ordersChecked: orders.length, itemsCancelled: cancelledItems };
}

// Online orders reserve stock at creation. If the customer never completes
// payment, release that stock after PAYMENT_WINDOW_MINUTES instead of
// holding it for a full seller-response window.
async function expireUnpaidOnlineOrders() {
  const cutoff = new Date(Date.now() - PAYMENT_WINDOW_MINUTES * 60 * 1000);
  const orders = await Order.find({
    paymentMethod: 'online',
    paymentStatus: { $in: ['pending', 'failed'] },
    orderStatus: { $nin: ['cancelled', 'rto'] },
    createdAt: { $lte: cutoff },
  });

  for (const order of orders) {
    for (const item of order.items) {
      if (item.itemStatus === 'cancelled' || item.itemStatus === 'rto') continue;
      await rejectAndSettleItem(order, item, {
        reason: 'Payment was not completed',
        source: 'system',
        sellerOrderStatus: 'cancelled',
        notify: false,
      });
    }
    order.cancelReason = order.cancelReason || 'Payment was not completed';
    await order.save();
  }

  if (orders.length) console.log(`[payment-window] cancelled ${orders.length} unpaid online order(s)`);
  return { ordersCancelled: orders.length };
}

async function runChecks() {
  await expireUnpaidOnlineOrders();
  await autoCancelUnansweredSellerItems();
}

function startWorker() {
  return startInterval('seller-response-window', runChecks, Math.min(CHECK_INTERVAL_MS, 5 * 60 * 1000));
}

module.exports = { autoCancelUnansweredSellerItems, expireUnpaidOnlineOrders, startWorker, respondByFor, SELLER_RESPONSE_WINDOW_HOURS };
