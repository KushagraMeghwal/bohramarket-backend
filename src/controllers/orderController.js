const mongoose = require('mongoose');
const crypto = require('crypto');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Seller = require('../models/Seller');
const User = require('../models/User');
const razorpay = require('../config/razorpay');
const asyncHandler = require('../utils/asyncHandler');
const { ITEM_STATUS_RANK, TERMINAL_ITEM_STATUSES, recalcOrderStatus, maybeStartReturnWindow } = require('../utils/orderStatus');
const shiprocketService = require('../services/shiprocket.service');
const notificationService = require('../services/notification.service');
const { computeShippingForCart, FLAT_SHIPPING_FEE: SHARED_FLAT_SHIPPING_FEE } = require('../services/shippingRate.service');
const { computeShipmentDimensions } = require('../services/orderFulfillment.service');
const { selectCourier } = require('../services/courierSelection.service');
const { refundItems, retryRefund: retryRefundRecord } = require('../services/refund.service');
const { rejectAndSettleItem } = require('../services/sellerItemSettlement.service');
const { isRazorpayConfigured } = require('../config/env');
const { MAX_QTY_PER_ITEM } = require('../config/shop');

const PHONE_PATTERN = /^[6-9]\d{9}$/;
const PINCODE_PATTERN = /^\d{6}$/;
const ADDRESS_FIELDS = ['fullName', 'phone', 'line1', 'line2', 'city', 'state', 'pincode', 'country'];

// Only the known address fields, trimmed — the request body is never stored
// as-is.
function cleanAddress(address) {
  const cleaned = {};
  ADDRESS_FIELDS.forEach((field) => {
    if (address?.[field] != null) cleaned[field] = String(address[field]).trim();
  });
  return cleaned;
}

function validateShippingAddress(address) {
  if (!address || typeof address !== 'object') return 'Shipping address is required';
  const a = cleanAddress(address);
  const missing = ['fullName', 'phone', 'line1', 'city', 'state', 'pincode'].filter((field) => !a[field]);
  if (missing.length) return `Shipping address is missing: ${missing.join(', ')}`;
  if (!PHONE_PATTERN.test(a.phone)) return 'Enter a valid 10-digit mobile number';
  if (!PINCODE_PATTERN.test(a.pincode)) return 'Enter a valid 6-digit pincode';
  return null;
}

// What the browser needs to open Razorpay checkout — nothing else from the
// Razorpay API response is passed through.
const publicRazorpayOrder = (rp) => ({ id: rp.id, amount: rp.amount, currency: rp.currency });

const timingSafeEqualHex = (a, b) => {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

// Strips other sellers' items (and the buyer's email) from an order a seller
// is looking at as the fulfilling seller, so in a multi-seller order no
// seller sees what anyone else sold or charged.
function redactForSeller(order, sellerId) {
  const plain = order.toObject ? order.toObject() : order;
  plain.items = plain.items.filter((item) => String(item.seller?._id ?? item.seller) === String(sellerId));
  if (plain.customer && typeof plain.customer === 'object') delete plain.customer.email;
  delete plain.razorpay;
  delete plain.refunds;
  return plain;
}

const clampLimit = (value, fallback = 20) => Math.min(Math.max(parseInt(value, 10) || fallback, 1), 100);
const clampPage = (value) => Math.max(parseInt(value, 10) || 1, 1);

const { notifySellersOfNewOrder, onOnlineOrderPaid } = require('../services/orderEvents.service');

const generateOrderNumber = () => `BM${Date.now()}${crypto.randomInt(100, 1000)}`;

// POST /api/orders
// Recalculates every price server-side from the live Product documents —
// the frontend's prices/totals are never trusted. Stock is decremented
// atomically inside a transaction so concurrent orders can't oversell.
const createOrder = asyncHandler(async (req, res) => {
  const { items, shippingAddress, paymentMethod } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'Order must contain at least one item' });
  }
  if (!shippingAddress) {
    return res.status(400).json({ message: 'Shipping address is required' });
  }
  if (!['online', 'COD'].includes(paymentMethod)) {
    return res.status(400).json({ message: "paymentMethod must be 'online' or 'COD'" });
  }
  const addressError = validateShippingAddress(shippingAddress);
  if (addressError) {
    return res.status(400).json({ message: addressError });
  }
  if (paymentMethod === 'online' && !isRazorpayConfigured()) {
    return res.status(503).json({ message: 'Online payment is temporarily unavailable. Please choose Cash on Delivery.' });
  }
  if (items.length > 50) {
    return res.status(400).json({ message: 'Too many items in one order' });
  }

  const productIds = items.map((i) => i.productId);
  const products = await Product.find({ _id: { $in: productIds } });
  const productMap = new Map(products.map((p) => [String(p._id), p]));

  const failures = [];
  const orderItems = [];
  let itemsTotal = 0;

  items.forEach(({ productId, quantity }) => {
    const product = productMap.get(String(productId));
    const qty = Number(quantity);

    if (!product) {
      failures.push({ productId, reason: 'Product not found' });
      return;
    }
    if (product.status !== 'active') {
      failures.push({ productId, reason: 'Product is not available for purchase' });
      return;
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_ITEM) {
      failures.push({ productId, reason: `Quantity must be a whole number between 1 and ${MAX_QTY_PER_ITEM}` });
      return;
    }
    if (product.stock < qty) {
      failures.push({
        productId,
        reason: `Only ${product.stock} left in stock`,
        availableStock: product.stock,
      });
      return;
    }

    const price = product.discountPrice ?? product.price;
    const subtotal = price * qty;
    itemsTotal += subtotal;

    orderItems.push({
      product: product._id,
      seller: product.seller,
      name: product.name,
      image: product.images?.[0]?.url,
      size: product.attributes?.size || undefined,
      price,
      quantity: qty,
      subtotal,
      itemStatus: 'placed',
    });
  });

  if (failures.length > 0) {
    return res.status(400).json({ message: 'Some items could not be ordered', failures });
  }

  // shippingFee/discount are derived server-side, never taken from the
  // client, for the same reason item prices are recalculated above (PART
  // 2.9 — mirrors the checkout shipping-estimate endpoint's own
  // computation, via the same shared function, so the two can't diverge).
  //
  // Deliberately lenient here even when computeShippingForCart reports a
  // seller as genuinely unserviceable: hard-blocking order creation on that
  // would be a new failure mode on the checkout critical path, and the
  // fulfillment chain already has a safety net for exactly this case (PART
  // 2.6 step 2 cancels+refunds the affected items once a seller accepts and
  // serviceability is re-checked for real). The hard block the task asked
  // for lives at the checkout-estimate step instead (checkoutController.js),
  // which the frontend calls *before* letting the customer submit — this is
  // the fallback path for a client that bypasses that step entirely.
  const groupedBySeller = new Map();
  orderItems.forEach((item) => {
    const sellerId = String(item.seller);
    if (!groupedBySeller.has(sellerId)) {
      groupedBySeller.set(sellerId, { items: [], productById: new Map(), subtotal: 0 });
    }
    const group = groupedBySeller.get(sellerId);
    group.items.push({ product: item.product, quantity: item.quantity, name: item.name });
    group.productById.set(String(item.product), productMap.get(String(item.product)));
    group.subtotal += item.subtotal;
  });

  const shippingResult = await computeShippingForCart({
    groupedBySeller,
    deliveryPincode: shippingAddress.pincode,
    paymentMethod,
    itemsTotal,
  });
  const shippingFee = shippingResult.serviceable ? shippingResult.shippingFee : SHARED_FLAT_SHIPPING_FEE;
  const discount = 0;
  const totalAmount = itemsTotal + shippingFee - discount;
  const orderNumber = generateOrderNumber();

  // The Razorpay order is created *before* any stock is reserved: if Razorpay
  // is down or rejects our keys, the customer gets an error and nothing is
  // left behind. (It used to be created after the DB transaction, so a
  // Razorpay failure stranded a stock-holding order with no way to pay.) An
  // unused Razorpay order simply expires on their side.
  let razorpayOrder;
  if (paymentMethod === 'online') {
    try {
      razorpayOrder = await razorpay.orders.create({
        amount: Math.round(totalAmount * 100),
        currency: 'INR',
        receipt: orderNumber,
      });
    } catch (err) {
      console.error(`[orders] Razorpay order creation failed for ${orderNumber}:`, err?.error || err.message || err);
      return res.status(502).json({ message: 'Could not start online payment right now. Please try again or choose Cash on Delivery.' });
    }
  }

  const session = await mongoose.startSession();
  let order;

  try {
    await session.withTransaction(async () => {
      for (const item of orderItems) {
        const updated = await Product.findOneAndUpdate(
          { _id: item.product, stock: { $gte: item.quantity } },
          { $inc: { stock: -item.quantity, totalSold: item.quantity } },
          { session }
        );
        if (!updated) {
          throw new Error(`STOCK_CONFLICT:${item.product}`);
        }
      }

      const [createdOrder] = await Order.create(
        [
          {
            orderNumber,
            customer: req.user._id,
            items: orderItems,
            shippingAddress: cleanAddress(shippingAddress),
            itemsTotal,
            shippingFee,
            discount,
            totalAmount,
            paymentMethod,
            paymentStatus: 'pending',
            orderStatus: 'placed',
            ...(razorpayOrder ? { razorpay: { orderId: razorpayOrder.id } } : {}),
          },
        ],
        { session }
      );
      order = createdOrder;
    });
  } catch (err) {
    if (err.message?.startsWith('STOCK_CONFLICT')) {
      return res.status(409).json({ message: 'Stock changed while placing your order, please retry' });
    }
    throw err;
  } finally {
    await session.endSession();
  }

  if (paymentMethod === 'online') {
    // Customer and sellers hear about a prepaid order only once it's paid
    // (verifyPayment / payment.captured webhook) — an abandoned payment
    // shouldn't send "order placed" emails for an order that will expire.
    return res.status(201).json({ order, razorpayOrder: publicRazorpayOrder(razorpayOrder), razorpayKeyId: process.env.RAZORPAY_KEY_ID });
  }

  // Items already default to sellerOrderStatus 'awaiting_seller' (see
  // Order.js orderItemSchema) — no further state change needed here. What
  // used to auto-fire Shiprocket fulfillment immediately on COD placement
  // now waits for each seller to explicitly accept
  // (sellerOrderActionController.acceptSellerItem), per the seller-
  // acceptance flow.
  notificationService.notifyCustomer({ order, templateKey: 'ORDER_PLACED', vars: { orderNumber: order.orderNumber } });
  notifySellersOfNewOrder(order);

  res.status(201).json({ order });
});

// GET /api/orders
const getOrders = asyncHandler(async (req, res) => {
  const { status, paymentStatus, dateFrom, dateTo, seller, scope } = req.query;
  const filter = {};
  let redactForSellerId = null;

  // scope=buyer: "My Orders" — the orders this account placed, whatever its
  // role (sellers and admins can shop too). Without it, a seller gets the
  // orders containing their items and an admin gets everything.
  if (req.user.role === 'customer' || scope === 'buyer') {
    filter.customer = req.user._id;
  } else if (req.user.role === 'seller') {
    const own = await Seller.findOne({ user: req.user._id });
    if (!own) return res.json({ orders: [], total: 0, page: 1, limit: 0 });
    filter['items.seller'] = own._id;
    redactForSellerId = own._id;
  } else if (seller) {
    // Admin-only: drill into one seller's orders (see admin/orders' seller
    // list — clicking a seller filters to just their orders).
    filter['items.seller'] = seller;
  }

  if (status) filter.orderStatus = status;
  if (paymentStatus) filter.paymentStatus = paymentStatus;

  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = new Date(`${dateFrom}T00:00:00.000Z`);
    if (dateTo) filter.createdAt.$lte = new Date(`${dateTo}T23:59:59.999Z`);
  }

  const pageNum = clampPage(req.query.page);
  const limitNum = clampLimit(req.query.limit);

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .populate('customer', 'name email phone')
      .populate('items.seller', 'businessName')
      .sort('-createdAt')
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum),
    Order.countDocuments(filter),
  ]);

  res.json({
    orders: redactForSellerId ? orders.map((order) => redactForSeller(order, redactForSellerId)) : orders,
    total,
    page: pageNum,
    limit: limitNum,
  });
});

// GET /api/orders/:id
const getOrderById = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id)
    .populate('customer', 'name email phone')
    .populate('items.product', 'name slug sku images price discountPrice')
    .populate('items.seller', 'businessName');
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }

  const isBuyer = String(order.customer._id) === String(req.user._id);

  if (req.user.role === 'customer' && !isBuyer) {
    return res.status(403).json({ message: 'Not your order' });
  }

  // A seller sees an order either as the fulfilling seller (they own items
  // in it) or, since sellers can also place orders as buyers, as the
  // customer who placed it — either is enough to view it.
  //
  // item.seller is populated above (items.seller -> businessName), so it's a
  // full Document here, not a bare ObjectId — String(item.seller) would
  // stringify the whole object, not its id, and never match. Read ._id
  // first so this works whether or not the field ends up populated.
  if (req.user.role === 'seller' && !isBuyer) {
    const seller = await Seller.findOne({ user: req.user._id });
    const ownsItem = order.items.some((item) => String(item.seller?._id ?? item.seller) === String(seller?._id));
    if (!ownsItem) {
      return res.status(403).json({ message: 'You have no items in this order' });
    }
    return res.json({ order: redactForSeller(order, seller._id) });
  }

  res.json({ order });
});

// PATCH /api/orders/:id/admin-status
// Admin override for the whole order. Items already cancelled/RTO are left
// alone (they used to be overwritten, so a cancelled item could be "marked
// delivered"); cancelling goes through the same settle path as every other
// cancellation, so stock is restored and prepaid money refunded.
const adminUpdateOrderStatus = asyncHandler(async (req, res) => {
  const { status, shipment } = req.body;
  const validStatuses = ['placed', 'packed', 'shipped', 'delivered', 'cancelled', 'rto'];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }

  const order = await Order.findById(req.params.id);
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }

  const activeItems = order.items.filter((item) => !TERMINAL_ITEM_STATUSES.includes(item.itemStatus));
  if (activeItems.length === 0) {
    return res.status(400).json({ message: `Every item in this order is already ${order.orderStatus}` });
  }
  if (!TERMINAL_ITEM_STATUSES.includes(status) && activeItems.some((item) => ITEM_STATUS_RANK[status] < ITEM_STATUS_RANK[item.itemStatus])) {
    return res.status(400).json({ message: `Some items are already past '${status}' — order status can't move backward` });
  }

  if (status === 'cancelled') {
    for (const item of activeItems) {
      if (item.itemStatus === 'shipped' || item.itemStatus === 'delivered') continue;
      await rejectAndSettleItem(order, item, { reason: req.body.reason || 'Cancelled by BohraMart', source: 'admin', sellerOrderStatus: 'cancelled' });
    }
    order.cancelReason = req.body.reason || order.cancelReason;
  } else {
    activeItems.forEach((item) => {
      item.itemStatus = status;
      item.statusHistory.push({ status, source: 'admin', at: new Date() });

      if (shipment || status === 'shipped' || status === 'delivered') {
        const shipmentUpdate = { ...(item.shipment?.toObject?.() ?? {}), ...(shipment ?? {}) };
        if (status === 'shipped') {
          shipmentUpdate.shipmentStatus = shipmentUpdate.shipmentStatus ?? 'shipped';
          shipmentUpdate.shippedAt = shipmentUpdate.shippedAt ?? new Date();
        }
        if (status === 'delivered') {
          shipmentUpdate.shipmentStatus = 'delivered';
          shipmentUpdate.deliveredAt = new Date();
          item.sellerOrderStatus = 'delivered';
        }
        item.shipment = shipmentUpdate;
      }
    });
    recalcOrderStatus(order);
  }

  maybeStartReturnWindow(order);
  await order.save();
  res.json({ order });
});

// PATCH /api/orders/:id/refund-status
// Manual bookkeeping for refunds settled outside Razorpay (COD orders paid
// back by bank transfer / UPI). Online refunds are tracked automatically
// from Razorpay and can't be overridden here.
const updateRefundStatus = asyncHandler(async (req, res) => {
  const { refundStatus } = req.body;
  if (!['refund_pending', 'refunded'].includes(refundStatus)) {
    return res.status(400).json({ message: 'Invalid refund status' });
  }

  const order = await Order.findById(req.params.id);
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }
  if (order.paymentMethod === 'online') {
    return res.status(400).json({ message: 'Online-payment refunds are processed through Razorpay automatically — use "Retry refund" if one failed.' });
  }

  order.refundStatus = refundStatus;
  if (refundStatus === 'refunded') {
    order.paymentStatus = 'refunded';
  }

  await order.save();
  res.json({ order });
});

// POST /api/orders/:id/refunds/:refundId/retry (admin)
const retryRefund = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }
  const refund = await retryRefundRecord(order, req.params.refundId);
  await order.save();
  if (refund.status === 'failed') {
    return res.status(502).json({ message: `Razorpay rejected the refund again: ${refund.error}`, order });
  }
  res.json({ order });
});

// POST /api/orders/:id/pay
// Lets a customer finish paying for an online order whose Razorpay window
// was closed or whose payment failed, instead of the order being stuck.
const payOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }
  if (String(order.customer) !== String(req.user._id)) {
    return res.status(403).json({ message: 'Not your order' });
  }
  if (order.paymentMethod !== 'online') {
    return res.status(400).json({ message: 'This is a Cash on Delivery order' });
  }
  if (order.paymentStatus === 'paid' || order.paymentStatus === 'refunded') {
    return res.status(400).json({ message: 'This order is already paid' });
  }
  if (order.orderStatus === 'cancelled') {
    return res.status(400).json({ message: 'This order has expired. Please place a new order.' });
  }
  if (!isRazorpayConfigured()) {
    return res.status(503).json({ message: 'Online payment is temporarily unavailable.' });
  }

  // A Razorpay order accepts repeated attempts until one succeeds, so the
  // original one is reused — keeping verifyPayment's order-id binding intact.
  let razorpayOrder;
  if (order.razorpay?.orderId) {
    razorpayOrder = { id: order.razorpay.orderId, amount: Math.round(order.totalAmount * 100), currency: 'INR' };
  } else {
    const created = await razorpay.orders.create({ amount: Math.round(order.totalAmount * 100), currency: 'INR', receipt: order.orderNumber });
    order.razorpay = { orderId: created.id };
    await order.save();
    razorpayOrder = publicRazorpayOrder(created);
  }

  res.json({ order, razorpayOrder, razorpayKeyId: process.env.RAZORPAY_KEY_ID });
});

// POST /api/orders/:id/verify-payment
const verifyPayment = asyncHandler(async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

  const order = await Order.findById(req.params.id);
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }
  if (String(order.customer) !== String(req.user._id)) {
    return res.status(403).json({ message: 'Not your order' });
  }
  if (order.paymentMethod !== 'online') {
    return res.status(400).json({ message: 'This order is not an online payment order' });
  }

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return res.status(400).json({ message: 'razorpayOrderId, razorpayPaymentId and razorpaySignature are required' });
  }

  // The signature only proves Razorpay saw *some* successful payment for
  // razorpayOrderId. It must also be the Razorpay order we created for this
  // order (and therefore for this exact amount) — otherwise a payment proof
  // from a cheap order could be replayed to mark an expensive one paid.
  if (!order.razorpay?.orderId || razorpayOrderId !== order.razorpay.orderId) {
    console.warn(`[verify-payment] order ${order.orderNumber}: razorpayOrderId mismatch (got ${razorpayOrderId}, expected ${order.razorpay?.orderId})`);
    return res.status(400).json({ message: 'Payment does not belong to this order' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  if (!timingSafeEqualHex(expectedSignature, razorpaySignature)) {
    return res.status(400).json({ message: 'Payment signature verification failed' });
  }

  if (order.paymentStatus === 'paid' || order.paymentStatus === 'refunded') {
    return res.json({ order });
  }
  if (order.orderStatus === 'cancelled') {
    // Paid after the payment window expired and the order was cancelled —
    // money must go straight back.
    order.paymentStatus = 'paid';
    order.paidAt = new Date();
    order.razorpay.paymentId = razorpayPaymentId;
    order.razorpay.signature = razorpaySignature;
    await refundItems(order, order.items, { reason: 'Payment received after the order expired' });
    await order.save();
    return res.status(409).json({ message: 'This order had already expired, so your payment is being refunded.', order });
  }

  order.paymentStatus = 'paid';
  order.paidAt = new Date();
  order.razorpay.paymentId = razorpayPaymentId;
  order.razorpay.signature = razorpaySignature;
  await order.save();

  onOnlineOrderPaid(order);

  // Same as createOrder's COD path: items are already 'awaiting_seller' by
  // default, so payment confirmation alone doesn't trigger fulfillment
  // anymore — the seller still has to explicitly accept. (The old
  // createShipmentForOrder auto-fire, and its idempotency-via-duplicate-call
  // concern with the Razorpay webhook, no longer applies now that nothing
  // fires automatically here or from webhookController's payment.captured
  // handler — see that handler's own comment.)
  //
  // Deliberately no SMS here: PART 1's flow has exactly two pre-shipping
  // customer milestones — ORDER_PLACED (already sent at createOrder, for
  // both COD and online) and ORDER_CONFIRMED / "confirmed, shipping soon"
  // (sent once fulfillment actually completes — fulfillment.service.js's
  // stepGenerateInvoice). Payment succeeding is an internal state change
  // between those two, not its own listed milestone — sending a third SMS
  // here would be the "spam every state change" this design is avoiding.
  // Sellers whose items were blocked from accepting by the payment-pending
  // guard (acceptSellerItem) ARE notified now, though — see the webhook
  // handler's own payment.captured comment.

  res.json({ order });
});

// PATCH /api/orders/:id/mark-cod-paid
const markCodPaid = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }
  if (order.paymentMethod !== 'COD') {
    return res.status(400).json({ message: 'Only COD orders can be marked paid this way' });
  }

  if (req.user.role === 'seller') {
    const seller = await Seller.findOne({ user: req.user._id });
    const ownsItem = order.items.some((item) => String(item.seller) === String(seller?._id));
    if (!ownsItem) {
      return res.status(403).json({ message: 'You have no items in this order' });
    }
  }

  order.paymentStatus = 'paid';
  await order.save();
  res.json({ order });
});

// PATCH /api/orders/:id/items/:itemId/status
const updateItemStatus = asyncHandler(async (req, res) => {
  const { status, shipment } = req.body;
  const validStatuses = ['placed', 'packed', 'shipped', 'delivered', 'cancelled', 'rto'];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }

  const order = await Order.findById(req.params.id);
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }

  const item = order.items.id(req.params.itemId);
  if (!item) {
    return res.status(404).json({ message: 'Order item not found' });
  }

  if (req.user.role === 'seller') {
    const seller = await Seller.findOne({ user: req.user._id });
    if (!seller || String(item.seller) !== String(seller._id)) {
      return res.status(403).json({ message: 'You do not own this item' });
    }
    // Packing/shipping an item the seller never accepted would skip
    // shipment booking, and the response-window job would still cancel it.
    if (item.sellerOrderStatus === 'awaiting_seller' && status !== 'cancelled') {
      return res.status(400).json({ message: 'Accept this order item first' });
    }
  }

  if (TERMINAL_ITEM_STATUSES.includes(item.itemStatus)) {
    return res.status(400).json({ message: `Item is already ${item.itemStatus} and cannot be changed` });
  }

  if (!TERMINAL_ITEM_STATUSES.includes(status) && ITEM_STATUS_RANK[status] <= ITEM_STATUS_RANK[item.itemStatus]) {
    return res.status(400).json({ message: `Cannot move item status backward from ${item.itemStatus} to ${status}` });
  }

  // Cancelling an item releases its stock and refunds it if prepaid — the
  // same settle path seller-reject and timeouts use.
  if (status === 'cancelled') {
    if (item.itemStatus === 'shipped' || item.itemStatus === 'delivered') {
      return res.status(400).json({ message: 'A shipped item cannot be cancelled — it has to come back as a return or RTO' });
    }
    await rejectAndSettleItem(order, item, {
      reason: req.body.reason || `Cancelled by ${req.user.role}`,
      source: req.user.role === 'admin' ? 'admin' : 'seller',
      sellerOrderStatus: 'cancelled',
    });
    maybeStartReturnWindow(order);
    await order.save();
    return res.json({ order });
  }

  item.itemStatus = status;
  item.statusHistory.push({ status, source: req.user.role === 'admin' ? 'admin' : 'seller', at: new Date() });

  if (shipment || status === 'shipped' || status === 'delivered') {
    const shipmentUpdate = { ...(item.shipment?.toObject?.() ?? {}), ...(shipment ?? {}) };
    if (status === 'shipped') {
      shipmentUpdate.shipmentStatus = shipmentUpdate.shipmentStatus ?? 'shipped';
      shipmentUpdate.shippedAt = shipmentUpdate.shippedAt ?? new Date();
    }
    if (status === 'delivered') {
      shipmentUpdate.shipmentStatus = 'delivered';
      shipmentUpdate.deliveredAt = new Date();
      item.sellerOrderStatus = 'delivered';
    }
    item.shipment = shipmentUpdate;
  }

  recalcOrderStatus(order);
  maybeStartReturnWindow(order);
  await order.save();

  res.json({ order });
});

// PATCH /api/orders/:id/cancel
// Customer (or admin) cancels everything that hasn't shipped yet. Stock is
// restored, any Shiprocket shipment cancelled, and a prepaid order refunded
// through Razorpay for exactly the cancelled items (+ shipping once nothing
// in the order will ship).
const cancelOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }

  // Only admins may cancel someone else's order; customer and seller
  // accounts (sellers can place orders as buyers too) may only cancel their
  // own.
  if (req.user.role !== 'admin' && String(order.customer) !== String(req.user._id)) {
    return res.status(403).json({ message: 'Not your order' });
  }

  if (!['placed', 'packed'].includes(order.orderStatus)) {
    return res.status(400).json({ message: `Order cannot be cancelled from status '${order.orderStatus}'` });
  }

  const reason = typeof req.body.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim().slice(0, 300) : 'Cancelled by customer';

  const cancellableItems = order.items.filter((item) => ['placed', 'packed'].includes(item.itemStatus));
  if (cancellableItems.length === 0) {
    return res.status(400).json({ message: 'Nothing left in this order can be cancelled' });
  }

  // Claim the items atomically first: two simultaneous cancel clicks (or a
  // cancel racing the seller-timeout job) must not both restore stock.
  const claimed = await Order.updateOne(
    { _id: order._id, orderStatus: { $in: ['placed', 'packed'] }, cancelReason: { $exists: false } },
    { $set: { cancelReason: reason } }
  );
  if (claimed.modifiedCount === 0) {
    return res.status(409).json({ message: 'This order is already being cancelled' });
  }
  order.cancelReason = reason;

  for (const item of cancellableItems) {
    item.itemStatus = 'cancelled';
    item.sellerOrderStatus = 'cancelled';
    item.statusHistory.push({ status: 'cancelled', source: req.user.role === 'admin' ? 'admin' : 'system', at: new Date() });
    await Product.findByIdAndUpdate(item.product, { $inc: { stock: item.quantity, totalSold: -item.quantity } });
  }
  recalcOrderStatus(order);

  const refund = await refundItems(order, cancellableItems, { reason });
  await order.save();

  // Best-effort: one cancel call per Shiprocket order created for the
  // cancelled items.
  const shiprocketOrderIds = [
    ...new Set(cancellableItems.map((item) => item.shipment?.shiprocketOrderId).filter(Boolean)),
  ];
  await Promise.all(
    shiprocketOrderIds.map((id) =>
      shiprocketService
        .cancelShipmentOrder(id)
        .catch((err) => console.error(`[shiprocket] failed to cancel shipment order ${id}`, err))
    )
  );

  const notifiedSellers = new Set();
  cancellableItems.forEach((item) => {
    const sellerId = String(item.seller);
    if (notifiedSellers.has(sellerId)) return;
    notifiedSellers.add(sellerId);
    notificationService.notifySeller(sellerId, `Order ${order.orderNumber} was cancelled by the customer — do not ship it`);
  });
  notificationService.notifyCustomer({
    order,
    templateKey: 'CANCELLED',
    vars: { orderNumber: order.orderNumber, reason, refund: !!refund && refund.status !== 'failed' },
  });

  res.json({ order });
});

// POST /api/orders/:id/return
const requestReturn = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id).populate('items.seller');
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }
  if (String(order.customer) !== String(req.user._id)) {
    return res.status(403).json({ message: 'Not your order' });
  }

  if (!order.returnEligibleUntil || Date.now() > order.returnEligibleUntil.getTime()) {
    return res.status(400).json({ message: 'Return window closed' });
  }
  if (order.returnStatus !== 'none') {
    return res.status(400).json({ message: `A return has already been ${order.returnStatus} for this order` });
  }

  // One Shiprocket return order per seller, same reasoning as
  // createShipmentForOrder — a return ships back to whichever seller's
  // warehouse the item came from, and Shiprocket has no multi-destination
  // concept for a single order.
  const sellerIds = [...new Set(order.items.map((item) => String(item.seller?._id || item.seller)))];
  const sellerUsers = await User.find({
    _id: { $in: order.items.map((item) => item.seller?.user).filter(Boolean) },
  }).select('email');
  const sellerEmailByUserId = new Map(sellerUsers.map((u) => [String(u._id), u.email]));

  const products = await Product.find({ _id: { $in: order.items.map((item) => item.product) } }).select('name weight dimensions');
  const productById = new Map(products.map((p) => [String(p._id), p]));

  // PART 2.11 pass 1: check reverse serviceability for every seller *before*
  // creating anything — a partial return (some sellers' packages picked up,
  // others silently failing mid-loop) is worse than telling the customer up
  // front which items can't be returned.
  const groupsBySellerId = new Map();
  const unserviceableProductNames = [];

  for (const sellerId of sellerIds) {
    const groupItems = order.items.filter((item) => String(item.seller?._id || item.seller) === sellerId);
    const seller = groupItems[0].seller;
    if (!seller || typeof seller === 'string') {
      console.warn(`[shiprocket] return for order ${order.orderNumber}: seller ${sellerId} not populated, skipping`);
      groupItems.forEach((item) => unserviceableProductNames.push(item.name));
      continue;
    }

    const dimensions = computeShipmentDimensions(
      groupItems.map((item) => ({ product: item.product, quantity: item.quantity, name: item.name })),
      productById
    );
    const declaredValue = groupItems.reduce((sum, item) => sum + item.subtotal, 0);

    try {
      const result = await shiprocketService.checkReturnServiceability({
        customerPincode: order.shippingAddress.pincode,
        sellerPincode: seller.pickupAddress.pincode,
        weight: dimensions.weight,
        declaredValue,
      });
      const couriers = result?.data?.available_courier_companies || [];
      const chosen = selectCourier(couriers, { paymentMethod: 'online' }); // returns are never COD — no cod-support filter needed

      if (!chosen) {
        groupItems.forEach((item) => unserviceableProductNames.push(item.name));
        continue;
      }

      groupsBySellerId.set(sellerId, { seller, groupItems, courierId: chosen.courierId, declaredValue });
    } catch (err) {
      // A Shiprocket outage here shouldn't block the return request outright
      // (rule 3) — fall back to attempting the return without a
      // pre-selected courier (Shiprocket auto-assigns one) rather than
      // treating a serviceability-check hiccup as "unserviceable".
      console.error(`[shiprocket] return serviceability check failed for order ${order.orderNumber}, seller ${sellerId}, proceeding without a pre-selected courier: ${err.message || err}`);
      groupsBySellerId.set(sellerId, { seller, groupItems, courierId: undefined, declaredValue });
    }
  }

  if (unserviceableProductNames.length > 0) {
    return res.status(422).json({
      message: `These items can't currently be picked up for return: ${unserviceableProductNames.join(', ')}`,
      unserviceableProductNames,
    });
  }

  // PART 2.11 pass 2: create the return order + assign a return AWB for
  // each seller now that every group is known serviceable.
  for (const [sellerId, { seller, groupItems, courierId }] of groupsBySellerId) {
    try {
      const response = await shiprocketService.requestReturn({
        orderNumber: order.orderNumber,
        orderDate: order.createdAt,
        customer: { name: order.shippingAddress.fullName, phone: order.shippingAddress.phone, email: req.user.email },
        shippingAddress: order.shippingAddress,
        sellerName: seller.businessName,
        sellerAddress: seller.pickupAddress,
        sellerEmail: sellerEmailByUserId.get(String(seller.user)) || 'orders@bohramart.example',
        sellerPhone: seller.contactPhone,
        items: groupItems.map((item) => ({ name: item.name, sku: String(item.product), quantity: item.quantity, price: item.price })),
        subTotal: groupItems.reduce((sum, item) => sum + item.subtotal, 0),
      });

      const returnOrderId = response?.order_id != null ? String(response.order_id) : undefined;
      const returnShipmentId = response?.shipment_id != null ? String(response.shipment_id) : undefined;

      let returnAwb;
      if (returnShipmentId) {
        try {
          const awbResponse = await shiprocketService.assignAwb({ shipmentId: returnShipmentId, courierId });
          const data = awbResponse?.response?.data || awbResponse?.data || awbResponse;
          returnAwb = data?.awb_code ? String(data.awb_code) : undefined;
        } catch (err) {
          // Return order itself was already created successfully — an AWB
          // assignment hiccup shouldn't fail the whole return, just means
          // the pickup AWB isn't known yet (Shiprocket may still assign one
          // on their side; the tracking webhook will pick it up later).
          console.error(`[shiprocket] return AWB assignment failed for order ${order.orderNumber}, seller ${sellerId}: ${err.message || err}`);
        }
      }

      groupItems.forEach((item) => {
        item.returnShipment = item.returnShipment || {};
        item.returnShipment.shiprocketOrderId = returnOrderId;
        item.returnShipment.shiprocketShipmentId = returnShipmentId;
        if (returnAwb) item.returnShipment.awbNumber = returnAwb;
        item.sellerOrderStatus = 'return_requested';
        item.statusHistory = item.statusHistory || [];
        item.statusHistory.push({ status: 'return_requested', source: 'system', at: new Date() });
      });

      notificationService.notifySeller(sellerId, `A return has been requested for order ${order.orderNumber} — pickup will be arranged.`);

      notificationService.notifyCustomer({
        order,
        templateKey: 'RETURN_INITIATED',
        vars: { orderNumber: order.orderNumber, returnAwbNumber: returnAwb },
      });
    } catch (err) {
      console.error(`[shiprocket] return request failed for order ${order.orderNumber}, seller ${sellerId}`, err);
      // Keep whatever returns were already created for earlier sellers —
      // dropping them here would orphan live Shiprocket pickups.
      await order.save();
      notificationService.notifyAdmin(`Return for order ${order.orderNumber} only partly created — seller ${sellerId} failed: ${err.message || err}`);
      return res.status(502).json({ message: 'Could not initiate the return with our courier partner. Please try again shortly.' });
    }
  }

  order.returnStatus = 'requested';
  await order.save();

  notificationService.notifyAdmin(`Return requested for order ${order.orderNumber}`);

  res.json({ order });
});

// GET /api/orders/:id/track
// Calls Shiprocket's live tracking API for each shipment on this order.
// Falls back to whatever's already stored on the order (from the last
// tracking webhook update) if the live call fails or a shipment doesn't
// exist yet — a Shiprocket outage should make this page stale, not broken.
const trackOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }

  const isBuyer = String(order.customer) === String(req.user._id);
  if (req.user.role === 'customer' && !isBuyer) {
    return res.status(403).json({ message: 'Not your order' });
  }
  if (req.user.role === 'seller' && !isBuyer) {
    const seller = await Seller.findOne({ user: req.user._id });
    const ownsItem = order.items.some((item) => String(item.seller) === String(seller?._id));
    if (!ownsItem) {
      return res.status(403).json({ message: 'You have no items in this order' });
    }
  }

  const seenShipmentIds = new Set();
  const tracking = [];

  for (const item of order.items) {
    const shipmentId = item.shipment?.shiprocketShipmentId;
    const fallback = {
      itemId: item._id,
      itemName: item.name,
      awb: item.shipment?.awbNumber || null,
      courierName: item.shipment?.courierName || null,
      status: item.shipment?.courierStatus || item.shipment?.shipmentStatus || item.itemStatus,
      trackingUrl: item.shipment?.awbNumber ? `https://shiprocket.co/tracking/${item.shipment.awbNumber}` : null,
      scans: [],
      live: false,
    };

    if (!shipmentId || seenShipmentIds.has(shipmentId)) {
      tracking.push(fallback);
      continue;
    }
    seenShipmentIds.add(shipmentId);

    try {
      const liveData = await shiprocketService.trackShipment(shipmentId);
      // Shiprocket's tracking response shape varies by account/endpoint
      // version — read every field defensively rather than assuming one
      // exact structure, and always fall back to our own stored status.
      const trackData = liveData?.tracking_data || liveData;
      const activities = trackData?.shipment_track_activities || trackData?.shipment_track || [];

      tracking.push({
        ...fallback,
        status: trackData?.track_status || trackData?.current_status || fallback.status,
        scans: Array.isArray(activities)
          ? activities.map((activity) => ({
              date: activity.date || '',
              status: activity.activity || activity.status || '',
              location: activity.location || '',
            }))
          : [],
        live: true,
      });
    } catch (err) {
      console.error(`[shiprocket] live tracking failed for shipment ${shipmentId}`, err.message || err);
      tracking.push(fallback);
    }
  }

  res.json({ tracking });
});

module.exports = {
  createOrder,
  getOrders,
  getOrderById,
  verifyPayment,
  markCodPaid,
  updateItemStatus,
  adminUpdateOrderStatus,
  updateRefundStatus,
  cancelOrder,
  requestReturn,
  trackOrder,
  payOrder,
  retryRefund,
};
