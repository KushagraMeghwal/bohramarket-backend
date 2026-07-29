const mongoose = require('mongoose');
const crypto = require('crypto');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Seller = require('../models/Seller');
const User = require('../models/User');
const razorpay = require('../config/razorpay');
const asyncHandler = require('../utils/asyncHandler');
const { ITEM_STATUS_RANK, TERMINAL_ITEM_STATUSES, recalcOrderStatus, maybeStartReturnWindow } = require('../utils/orderStatus');
const { createShipmentForOrder } = require('../services/orderFulfillment.service');
const shiprocketService = require('../services/shiprocket.service');

const generateOrderNumber = () => `BM${Date.now()}${Math.floor(Math.random() * 1000)}`;

const FLAT_SHIPPING_FEE = 49;
const FREE_SHIPPING_THRESHOLD = 999;

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
    if (!qty || qty < 1) {
      failures.push({ productId, reason: 'Invalid quantity' });
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
  // client, for the same reason item prices are recalculated above.
  const shippingFee = itemsTotal >= FREE_SHIPPING_THRESHOLD ? 0 : FLAT_SHIPPING_FEE;
  const discount = 0;
  const totalAmount = itemsTotal + shippingFee - discount;
  const orderNumber = generateOrderNumber();

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
            shippingAddress,
            itemsTotal,
            shippingFee,
            discount,
            totalAmount,
            paymentMethod,
            paymentStatus: 'pending',
            orderStatus: 'placed',
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
    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(totalAmount * 100),
      currency: 'INR',
      receipt: order.orderNumber,
    });
    order.razorpay = { orderId: razorpayOrder.id };
    await order.save();

    return res.status(201).json({ order, razorpayOrder });
  }

  // COD orders are "confirmed" the moment they're placed — there's no
  // separate payment step to wait for the way there is for online orders
  // (see verifyPayment / webhookController.handlePaymentCaptured). Not
  // awaited: a Shiprocket outage shouldn't delay or fail order placement.
  createShipmentForOrder(order);

  res.status(201).json({ order });
});

// GET /api/orders
const getOrders = asyncHandler(async (req, res) => {
  const { status, paymentStatus, dateFrom, dateTo, page = 1, limit = 20 } = req.query;
  const filter = {};

  if (req.user.role === 'customer') {
    filter.customer = req.user._id;
  } else if (req.user.role === 'seller') {
    const seller = await Seller.findOne({ user: req.user._id });
    filter['items.seller'] = seller?._id;
  }

  if (status) filter.orderStatus = status;
  if (paymentStatus) filter.paymentStatus = paymentStatus;

  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = new Date(`${dateFrom}T00:00:00.000Z`);
    if (dateTo) filter.createdAt.$lte = new Date(`${dateTo}T23:59:59.999Z`);
  }

  const pageNum = Number(page);
  const limitNum = Number(limit);

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .populate('customer', 'name email phone')
      .sort('-createdAt')
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum),
    Order.countDocuments(filter),
  ]);

  res.json({ orders, total, page: pageNum, limit: limitNum });
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
  }

  res.json({ order });
});

// PATCH /api/orders/:id/admin-status
const adminUpdateOrderStatus = asyncHandler(async (req, res) => {
  const { status, refundStatus, shipment } = req.body;
  const validStatuses = ['placed', 'packed', 'shipped', 'delivered', 'cancelled', 'rto'];
  const validRefundStatuses = ['refund_pending', 'refunded'];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }

  const order = await Order.findById(req.params.id);
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }

  order.items.forEach((item) => {
    item.itemStatus = status;

    if (shipment || status === 'shipped' || status === 'delivered') {
      const shipmentUpdate = { ...(item.shipment?.toObject?.() ?? {}), ...(shipment ?? {}) };
      if (status === 'shipped') {
        shipmentUpdate.shipmentStatus = shipmentUpdate.shipmentStatus ?? 'shipped';
        shipmentUpdate.shippedAt = shipmentUpdate.shippedAt ?? new Date();
      }
      if (status === 'delivered') {
        shipmentUpdate.shipmentStatus = 'delivered';
        shipmentUpdate.deliveredAt = new Date();
      }
      item.shipment = shipmentUpdate;
    }
  });

  order.orderStatus = status;
  maybeStartReturnWindow(order);

  if (refundStatus !== undefined) {
    if (!validRefundStatuses.includes(refundStatus)) {
      return res.status(400).json({ message: 'Invalid refund status' });
    }
    order.refundStatus = refundStatus;
    if (refundStatus === 'refunded') {
      order.paymentStatus = 'refunded';
    }
  }

  await order.save();
  res.json({ order });
});

// PATCH /api/orders/:id/refund-status
const updateRefundStatus = asyncHandler(async (req, res) => {
  const { refundStatus } = req.body;
  if (!['refund_pending', 'refunded'].includes(refundStatus)) {
    return res.status(400).json({ message: 'Invalid refund status' });
  }

  const order = await Order.findById(req.params.id);
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }

  order.refundStatus = refundStatus;
  if (refundStatus === 'refunded') {
    order.paymentStatus = 'refunded';
  }

  await order.save();
  res.json({ order });
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

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  if (expectedSignature !== razorpaySignature) {
    return res.status(400).json({ message: 'Payment signature verification failed' });
  }

  order.paymentStatus = 'paid';
  order.razorpay = {
    orderId: razorpayOrderId,
    paymentId: razorpayPaymentId,
    signature: razorpaySignature,
  };
  await order.save();

  // Not awaited — see createOrder's COD call for why. The Razorpay
  // payment.captured webhook also calls this for the same order; the
  // idempotency check inside createShipmentForOrder is what stops whichever
  // of the two fires second from double-booking the shipment.
  createShipmentForOrder(order);

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
  }

  if (TERMINAL_ITEM_STATUSES.includes(item.itemStatus)) {
    return res.status(400).json({ message: `Item is already ${item.itemStatus} and cannot be changed` });
  }

  if (!TERMINAL_ITEM_STATUSES.includes(status) && ITEM_STATUS_RANK[status] <= ITEM_STATUS_RANK[item.itemStatus]) {
    return res.status(400).json({ message: `Cannot move item status backward from ${item.itemStatus} to ${status}` });
  }

  item.itemStatus = status;

  if (shipment || status === 'shipped' || status === 'delivered') {
    const shipmentUpdate = { ...(item.shipment?.toObject?.() ?? {}), ...(shipment ?? {}) };
    if (status === 'shipped') {
      shipmentUpdate.shipmentStatus = shipmentUpdate.shipmentStatus ?? 'shipped';
      shipmentUpdate.shippedAt = shipmentUpdate.shippedAt ?? new Date();
    }
    if (status === 'delivered') {
      shipmentUpdate.shipmentStatus = 'delivered';
      shipmentUpdate.deliveredAt = new Date();
    }
    item.shipment = shipmentUpdate;
  }

  recalcOrderStatus(order);
  maybeStartReturnWindow(order);
  await order.save();

  res.json({ order });
});

// PATCH /api/orders/:id/cancel
// Kept as the existing PATCH endpoint rather than adding a separate POST
// route — this codebase already had a working cancelOrder (stock restore,
// role checks, etc.) and the frontend already calls PATCH; a second route
// doing overlapping-but-different cancel logic would be a bug waiting to
// happen rather than a real addition. This now also tightens the allowed
// states and cancels any Shiprocket shipment already created for the order.
const cancelOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }

  // Only admins may cancel someone else's order; customer and seller
  // accounts (sellers can place orders as buyers too, see orderRoutes.js
  // BUYER_ROLES) may only cancel their own.
  if (req.user.role !== 'admin' && String(order.customer) !== String(req.user._id)) {
    return res.status(403).json({ message: 'Not your order' });
  }

  // Cancellation is only offered before the order ships — once a courier has
  // picked it up, this needs to become a return instead (see requestReturn).
  if (!['placed', 'packed'].includes(order.orderStatus)) {
    return res.status(400).json({ message: `Order cannot be cancelled from status '${order.orderStatus}'` });
  }

  const { reason } = req.body;

  const cancellableItems = order.items.filter(
    (item) => !TERMINAL_ITEM_STATUSES.includes(item.itemStatus) && item.itemStatus !== 'delivered'
  );

  await Promise.all(
    cancellableItems.map((item) =>
      Product.findByIdAndUpdate(item.product, {
        $inc: { stock: item.quantity, totalSold: -item.quantity },
      })
    )
  );

  cancellableItems.forEach((item) => {
    item.itemStatus = 'cancelled';
  });

  order.orderStatus = 'cancelled';
  order.cancelReason = reason;
  await order.save();

  // Best-effort: cancelling in our DB is the source of truth for the buyer;
  // a Shiprocket API hiccup here shouldn't block that response. Only one
  // cancel call per unique Shiprocket order id, since several items from the
  // same seller share one Shiprocket order.
  const shiprocketOrderIds = [
    ...new Set(order.items.map((item) => item.shipment?.shiprocketOrderId).filter(Boolean)),
  ];
  await Promise.all(
    shiprocketOrderIds.map((id) =>
      shiprocketService
        .cancelShipmentOrder(id)
        .catch((err) => console.error(`[shiprocket] failed to cancel shipment order ${id}`, err))
    )
  );

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

  for (const sellerId of sellerIds) {
    const groupItems = order.items.filter((item) => String(item.seller?._id || item.seller) === sellerId);
    const seller = groupItems[0].seller;
    if (!seller || typeof seller === 'string') {
      console.warn(`[shiprocket] return for order ${order.orderNumber}: seller ${sellerId} not populated, skipping`);
      continue;
    }

    try {
      await shiprocketService.requestReturn({
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
    } catch (err) {
      console.error(`[shiprocket] return request failed for order ${order.orderNumber}, seller ${sellerId}`, err);
      return res.status(502).json({ message: 'Could not initiate the return with our courier partner. Please try again shortly.' });
    }
  }

  order.returnStatus = 'requested';
  await order.save();

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
};
