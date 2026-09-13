// Auto-cancels any order item still sitting in 'awaiting_seller' past its
// response window (PART 1: "auto-cancel that seller's sub-order... do not
// cancel the whole parent order if other sellers accepted" — handled
// per-item, not per-order, since one multi-seller order can have some
// items accepted and others timed out).
const Order = require('../models/Order');
const { rejectAndSettleItem } = require('./sellerItemSettlement.service');
const { startInterval } = require('../utils/scheduler');

const SELLER_RESPONSE_WINDOW_HOURS = Number(process.env.SELLER_RESPONSE_WINDOW_HOURS) || 24;
const CHECK_INTERVAL_MS = Number(process.env.SELLER_RESPONSE_CHECK_INTERVAL_MS) || 15 * 60 * 1000; // 15 min

async function autoCancelUnansweredSellerItems() {
  const cutoff = new Date(Date.now() - SELLER_RESPONSE_WINDOW_HOURS * 60 * 60 * 1000);

  const orders = await Order.find({
    'items.sellerOrderStatus': 'awaiting_seller',
    createdAt: { $lte: cutoff },
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
    if (touched) await order.save();
  }

  if (cancelledItems > 0) {
    console.log(`[seller-response-window] auto-cancelled ${cancelledItems} unanswered item(s) across ${orders.length} order(s)`);
  }

  return { ordersChecked: orders.length, itemsCancelled: cancelledItems };
}

function startWorker() {
  return startInterval('seller-response-window', autoCancelUnansweredSellerItems, CHECK_INTERVAL_MS);
}

module.exports = { autoCancelUnansweredSellerItems, startWorker, SELLER_RESPONSE_WINDOW_HOURS };
