const notificationService = require('./notification.service');

// Every seller represented in an order gets exactly one notification, even
// if they have several items in it.
function notifySellersOfNewOrder(order) {
  const notified = new Set();
  order.items.forEach((item) => {
    const sellerId = String(item.seller?._id ?? item.seller);
    if (notified.has(sellerId)) return;
    notified.add(sellerId);
    notificationService.notifySeller(sellerId, `New order ${order.orderNumber} is waiting for you to accept or reject it`);
  });
}

// Called by whichever path first moves an online order to 'paid'
// (verifyPayment or the payment.captured / order.paid webhook) — both only
// call it on the actual pending→paid transition, so it fires once.
function onOnlineOrderPaid(order) {
  notificationService.notifyCustomer({ order, templateKey: 'ORDER_PLACED', vars: { orderNumber: order.orderNumber } });
  notifySellersOfNewOrder(order);
}

module.exports = { notifySellersOfNewOrder, onOnlineOrderPaid };
