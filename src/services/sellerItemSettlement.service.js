const Product = require('../models/Product');
const { recalcOrderStatus } = require('../utils/orderStatus');
const notificationService = require('./notification.service');

// Shared by the seller's manual "Reject" action and the auto-cancel-after-
// timeout cron (sellerResponseWindow.service.js) — both need to do exactly
// the same thing to an item: mark it rejected/cancelled, restore its stock,
// flag a refund if the order was already paid, and record why. One function
// so the two call sites can't drift out of sync on what "rejecting a
// seller's item" actually means.
//
// Caller is responsible for order.save() — this only mutates in memory so a
// caller iterating multiple items on the same order can batch one save.
async function rejectAndSettleItem(order, item, { reason, source }) {
  item.sellerOrderStatus = 'rejected';
  item.itemStatus = 'cancelled';
  item.sellerRejectReason = reason;
  item.sellerRespondedAt = item.sellerRespondedAt || new Date();
  item.statusHistory.push({ status: 'rejected', source, at: new Date() });

  await Product.findByIdAndUpdate(item.product, {
    $inc: { stock: item.quantity, totalSold: -item.quantity },
  });

  // Only this item's slice needs refunding — other sellers' items in the
  // same order may still be fulfilled normally. Note: no real payment-
  // gateway refund call exists anywhere in this codebase yet (no Razorpay
  // refund API usage found) — this only records refund *intent* on the
  // order for admin to action, the same pattern requestReturn/the RTO
  // webhook path already use for refundStatus.
  const triggersRefund = order.paymentMethod === 'online' && order.paymentStatus === 'paid' && order.refundStatus !== 'refunded';
  if (triggersRefund) {
    order.refundStatus = 'refund_pending';
  }

  recalcOrderStatus(order);

  notificationService.sendSms({
    to: order.shippingAddress?.phone,
    templateKey: 'CANCELLED',
    vars: { orderNumber: order.orderNumber, itemName: item.name, reason, refund: triggersRefund },
  });
  if (triggersRefund) {
    notificationService.sendSms({ to: order.shippingAddress?.phone, templateKey: 'REFUND_INITIATED', vars: { orderNumber: order.orderNumber } });
  }
}

module.exports = { rejectAndSettleItem };
