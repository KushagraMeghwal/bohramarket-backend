const Order = require('../models/Order');
const Seller = require('../models/Seller');
const asyncHandler = require('../utils/asyncHandler');
const shipmentJobQueue = require('../services/shipmentJobQueue.service');
const { rejectAndSettleItem } = require('../services/sellerItemSettlement.service');
const { SELLER_RESPONSE_WINDOW_HOURS } = require('../services/sellerResponseWindow.service');

// GET /api/seller/orders/pending
// One row per awaiting_seller item this seller owns, not per order — a
// seller managing a request queue wants item-level entries, since a
// multi-seller order may have only one item that's actually theirs.
const getPendingSellerItems = asyncHandler(async (req, res) => {
  const seller = await Seller.findOne({ user: req.user._id });
  if (!seller) {
    return res.status(404).json({ message: 'Seller profile not found' });
  }

  const orders = await Order.find({
    'items.seller': seller._id,
    'items.sellerOrderStatus': 'awaiting_seller',
  })
    .populate('customer', 'name')
    .sort('-createdAt');

  const pending = [];
  orders.forEach((order) => {
    order.items.forEach((item) => {
      if (String(item.seller) === String(seller._id) && item.sellerOrderStatus === 'awaiting_seller') {
        pending.push({
          orderId: order._id,
          orderNumber: order.orderNumber,
          itemId: item._id,
          productName: item.name,
          quantity: item.quantity,
          subtotal: item.subtotal,
          customerName: order.customer?.name,
          placedAt: order.createdAt,
          respondBy: new Date(order.createdAt.getTime() + SELLER_RESPONSE_WINDOW_HOURS * 60 * 60 * 1000),
        });
      }
    });
  });

  res.json({ pending });
});

// POST /api/seller/orders/:orderId/items/:itemId/accept
const acceptSellerItem = asyncHandler(async (req, res) => {
  const seller = await Seller.findOne({ user: req.user._id });
  if (!seller) {
    return res.status(404).json({ message: 'Seller profile not found' });
  }

  const order = await Order.findById(req.params.orderId);
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }

  const item = order.items.id(req.params.itemId);
  if (!item) {
    return res.status(404).json({ message: 'Order item not found' });
  }

  // Never trust the URL alone — confirm this item actually belongs to the
  // authenticated seller before allowing any state change.
  if (String(item.seller) !== String(seller._id)) {
    return res.status(403).json({ message: 'You do not own this item' });
  }

  if (item.sellerOrderStatus !== 'awaiting_seller') {
    return res.status(400).json({ message: `Item already ${item.sellerOrderStatus}, cannot accept` });
  }

  // Guard not present in the original flow spec, added deliberately: an
  // online-payment item sits in 'awaiting_seller' from the moment the order
  // is created (same as COD), which is before payment is necessarily
  // confirmed. Letting a seller accept — and this kicking off real
  // Shiprocket fulfillment — for an order that was never actually paid for
  // would be a real business bug, not just a UX nicety.
  if (order.paymentMethod === 'online' && order.paymentStatus !== 'paid') {
    return res.status(400).json({ message: 'Cannot accept: payment for this order has not been confirmed yet' });
  }

  item.sellerOrderStatus = 'accepted';
  item.sellerRespondedAt = new Date();
  item.statusHistory.push({ status: 'accepted', source: 'seller', at: new Date() });
  await order.save();

  // Queued, not inline — a Shiprocket outage must never block this response
  // (see PART 5 rule 3). The chain's first step is ensure_pickup (PART 2.6).
  await shipmentJobQueue.enqueueJob({ orderId: order._id, sellerId: seller._id, step: 'ensure_pickup' });

  // No SMS here on purpose: PART 1's "Confirmed, shipping soon" fires once
  // the fulfillment chain actually finishes (fulfillment.service.js's
  // stepGenerateInvoice) — sending it here too, before AWB/pickup/label even
  // exist, would tell the customer something that isn't true yet.

  res.json({ order });
});

// POST /api/seller/orders/:orderId/items/:itemId/reject
const rejectSellerItem = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  if (!reason) {
    return res.status(400).json({ message: 'A rejection reason is required' });
  }

  const seller = await Seller.findOne({ user: req.user._id });
  if (!seller) {
    return res.status(404).json({ message: 'Seller profile not found' });
  }

  const order = await Order.findById(req.params.orderId);
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }

  const item = order.items.id(req.params.itemId);
  if (!item) {
    return res.status(404).json({ message: 'Order item not found' });
  }

  if (String(item.seller) !== String(seller._id)) {
    return res.status(403).json({ message: 'You do not own this item' });
  }

  if (item.sellerOrderStatus !== 'awaiting_seller') {
    return res.status(400).json({ message: `Item already ${item.sellerOrderStatus}, cannot reject` });
  }

  // rejectAndSettleItem itself sends the CANCELLED (and, if applicable,
  // REFUND_INITIATED) SMS — same code path the auto-cancel cron uses, so
  // manual reject and timeout-cancel can't drift apart on notification
  // behavior either.
  await rejectAndSettleItem(order, item, { reason, source: 'seller' });
  await order.save();

  res.json({ order });
});

module.exports = { getPendingSellerItems, acceptSellerItem, rejectSellerItem };
