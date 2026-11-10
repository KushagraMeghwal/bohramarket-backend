const Product = require('../models/Product');
const { recalcOrderStatus } = require('../utils/orderStatus');
const notificationService = require('./notification.service');
const { refundItems } = require('./refund.service');

// Shared by every path that takes an item away from a customer before it
// ships — seller reject, seller no-response timeout, unserviceable pincode,
// unpaid-order expiry and admin cancel — so stock restoration, refunds and
// the customer notification can't drift apart between them. Callers save.
async function rejectAndSettleItem(order, item, { reason, source, sellerOrderStatus = 'rejected', notify = true }) {
  item.sellerOrderStatus = sellerOrderStatus;
  item.itemStatus = 'cancelled';
  item.sellerRejectReason = reason;
  item.sellerRespondedAt = item.sellerRespondedAt || new Date();
  item.statusHistory.push({ status: sellerOrderStatus, source, at: new Date() });

  await Product.findByIdAndUpdate(item.product, {
    $inc: { stock: item.quantity, totalSold: -item.quantity },
  });

  recalcOrderStatus(order);
  const refund = await refundItems(order, [item], { reason });

  if (notify) {
    notificationService.notifyCustomer({
      order,
      templateKey: 'CANCELLED',
      vars: { orderNumber: order.orderNumber, itemName: item.name, reason, refund: !!refund && refund.status !== 'failed' },
    });
  }
  return refund;
}

module.exports = { rejectAndSettleItem };
