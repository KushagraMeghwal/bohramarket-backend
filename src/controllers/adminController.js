const Seller = require('../models/Seller');
const Product = require('../models/Product');
const Order = require('../models/Order');
const ShipmentJob = require('../models/ShipmentJob');
const shipmentJobQueue = require('../services/shipmentJobQueue.service');
const asyncHandler = require('../utils/asyncHandler');

const RETURN_STATUSES = ['return_requested', 'return_picked', 'return_delivered'];

// Revenue = money actually collected: prepaid orders that were paid, plus
// COD orders that were delivered (or marked paid), less anything refunded.
// It used to sum every order's total, including unpaid and cancelled ones.
const REALIZED_REVENUE_MATCH = {
  $or: [{ paymentStatus: { $in: ['paid', 'refunded'] } }, { paymentMethod: 'COD', orderStatus: 'delivered' }],
};
const REALIZED_AMOUNT = { $subtract: ['$totalAmount', { $ifNull: ['$refundedAmount', 0] }] };

const getDashboard = asyncHandler(async (req, res) => {
  const [sellerCounts, productCounts, totalOrders, revenueAgg, pendingSellers, pendingProducts] = await Promise.all([
    Seller.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Product.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Order.countDocuments(),
    Order.aggregate([
      { $match: REALIZED_REVENUE_MATCH },
      { $group: { _id: null, totalRevenue: { $sum: REALIZED_AMOUNT } } },
    ]),
    Seller.find({ status: 'pending' }).populate('user', 'name email phone').sort('-createdAt').limit(5),
    Product.find({ status: 'pending_review' })
      .populate('seller', 'businessName')
      .populate('category', 'name slug')
      .sort('-createdAt')
      .limit(5),
  ]);

  const sellersByStatus = {
    pending: 0,
    approved: 0,
    rejected: 0,
    suspended: 0,
  };

  sellerCounts.forEach(({ _id, count }) => {
    if (_id in sellersByStatus) sellersByStatus[_id] = count;
  });

  const productsByStatus = {
    pending_review: 0,
    active: 0,
    rejected: 0,
    inactive: 0,
  };

  productCounts.forEach(({ _id, count }) => {
    if (_id in productsByStatus) productsByStatus[_id] = count;
  });

  res.json({
    stats: {
      sellersByStatus,
      productsByStatus,
      totalOrders,
      totalRevenue: revenueAgg[0]?.totalRevenue || 0,
    },
    pendingSellers,
    pendingProducts,
  });
});

// GET /api/admin/needs-attention
// PART 2.12: one consolidated view of everything the fulfillment automation
// (PARTs 2.4-2.11) couldn't resolve on its own and needs a human to look at.
const getNeedsAttention = asyncHandler(async (req, res) => {
  const [failedJobs, failedPickupRegistrations, unserviceableOrderDocs, missedResponseOrderDocs, failedRefundOrderDocs] = await Promise.all([
    ShipmentJob.find({ status: 'needs_attention' })
      .populate('order', 'orderNumber')
      .populate('seller', 'businessName')
      .sort('-updatedAt'),
    Seller.find({ shiprocketPickupStatus: 'failed' }).select(
      'businessName shiprocketPickupError shiprocketPickupRegisteredAt updatedAt'
    ),
    // There's no dedicated "why was this item rejected" enum field —
    // sellerRejectReason is deliberately free text (see Order.js) — so
    // telling "unserviceable pincode" apart from "seller missed the
    // response window" here means matching the two distinct reason strings
    // those exact call sites write (fulfillment.service.js's
    // stepServiceability, sellerResponseWindow.service.js).
    Order.find({ 'items.sellerRejectReason': { $regex: /no courier is serviceable/i } })
      .select('orderNumber items createdAt')
      .sort('-createdAt')
      .limit(50),
    Order.find({ 'items.sellerRejectReason': { $regex: /no response from seller within/i } })
      .select('orderNumber items createdAt')
      .sort('-createdAt')
      .limit(50),
    Order.find({ 'refunds.status': 'failed' }).select('orderNumber refunds createdAt').sort('-updatedAt').limit(50),
  ]);

  const failedRefunds = failedRefundOrderDocs.flatMap((order) =>
    order.refunds
      .filter((refund) => refund.status === 'failed')
      .map((refund) => ({
        orderId: order._id,
        orderNumber: order.orderNumber,
        refundId: refund._id,
        amount: refund.amount,
        reason: refund.reason,
        error: refund.error,
        createdAt: refund.createdAt,
      }))
  );

  // Flattened to just the affected item(s) — an order can have other,
  // unrelated items mixed in, and an admin reading this list shouldn't have
  // to re-derive which item(s) actually triggered the match.
  const unserviceableOrders = unserviceableOrderDocs.flatMap((order) =>
    order.items
      .filter((item) => /no courier is serviceable/i.test(item.sellerRejectReason || ''))
      .map((item) => ({
        orderId: order._id,
        orderNumber: order.orderNumber,
        itemName: item.name,
        reason: item.sellerRejectReason,
        createdAt: order.createdAt,
      }))
  );

  const missedResponseWindow = missedResponseOrderDocs.flatMap((order) =>
    order.items
      .filter((item) => /no response from seller within/i.test(item.sellerRejectReason || ''))
      .map((item) => ({
        orderId: order._id,
        orderNumber: order.orderNumber,
        itemName: item.name,
        sellerId: item.seller,
        reason: item.sellerRejectReason,
        createdAt: order.createdAt,
      }))
  );

  res.json({ failedJobs, failedPickupRegistrations, unserviceableOrders, missedResponseWindow, failedRefunds });
});

// POST /api/admin/shipment-jobs/:id/retry
// Re-queues a needs_attention job from its failed step (not from the
// beginning of the chain) — reuses shipmentJobQueue.enqueueJob so this goes
// through the exact same reset logic a normal chain-progression enqueue
// does, rather than a second, parallel way of resetting a job's fields.
const retryShipmentJob = asyncHandler(async (req, res) => {
  const job = await ShipmentJob.findById(req.params.id);
  if (!job) {
    return res.status(404).json({ message: 'Job not found' });
  }

  const updated = await shipmentJobQueue.enqueueJob({ orderId: job.order, sellerId: job.seller, step: job.step });
  res.json({ job: updated });
});

// GET /api/admin/badge-counts — cheap counts-only version of what
// getDashboard/getNeedsAttention compute, polled by the admin sidebar to
// drive its red notification badges. Deliberately not reusing those two
// handlers: the sidebar renders on every admin page, so it needs to stay a
// count-only query rather than pulling the full populated documents both of
// those return.
const getBadgeCounts = asyncHandler(async (req, res) => {
  const [pendingSellers, pendingProducts, needsAttentionJobs, failedPickups, unserviceableCount, missedResponseCount, failedRefundCount] =
    await Promise.all([
      Seller.countDocuments({ status: 'pending' }),
      Product.countDocuments({ status: 'pending_review' }),
      ShipmentJob.countDocuments({ status: 'needs_attention' }),
      Seller.countDocuments({ shiprocketPickupStatus: 'failed' }),
      Order.countDocuments({ 'items.sellerRejectReason': { $regex: /no courier is serviceable/i } }),
      Order.countDocuments({ 'items.sellerRejectReason': { $regex: /no response from seller within/i } }),
      Order.countDocuments({ 'refunds.status': 'failed' }),
    ]);

  res.json({
    pendingSellers,
    pendingProducts,
    needsAttention: needsAttentionJobs + failedPickups + unserviceableCount + missedResponseCount + failedRefundCount,
  });
});

// GET /api/admin/analytics?date=YYYY-MM-DD (optional)
// Powers the redesigned dashboard: a revenue time series (30 days, or a
// single day when the calendar picker supplies `date`), category demand,
// top-rated products, and per-seller return rate. There's no dedicated
// "complaint" system in this codebase (no ticket/dispute model) — return
// rate is used as the closest real signal for "which seller has more
// returns/complaints" rather than inventing a metric nothing feeds.
const getAnalytics = asyncHandler(async (req, res) => {
  const { date } = req.query;

  let rangeStart;
  let rangeEnd;
  if (date) {
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ message: 'Invalid date' });
    }
    rangeStart = new Date(parsed);
    rangeStart.setHours(0, 0, 0, 0);
    rangeEnd = new Date(rangeStart.getTime() + 24 * 60 * 60 * 1000);
  } else {
    rangeEnd = new Date();
    rangeStart = new Date(rangeEnd.getTime() - 29 * 24 * 60 * 60 * 1000);
    rangeStart.setHours(0, 0, 0, 0);
  }

  const [revenueByDay, categoryDemand, topLovedProducts, sellerReturnRates] = await Promise.all([
    Order.aggregate([
      { $match: { createdAt: { $gte: rangeStart, $lt: rangeEnd }, ...REALIZED_REVENUE_MATCH } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } },
          revenue: { $sum: REALIZED_AMOUNT },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', revenue: 1, orders: 1 } },
    ]),

    Order.aggregate([
      { $match: { createdAt: { $gte: rangeStart, $lt: rangeEnd } } },
      { $unwind: '$items' },
      { $match: { 'items.itemStatus': { $nin: ['cancelled', 'rto'] } } },
      { $lookup: { from: 'products', localField: 'items.product', foreignField: '_id', as: 'productDoc' } },
      { $unwind: '$productDoc' },
      { $group: { _id: '$productDoc.category', unitsSold: { $sum: '$items.quantity' }, revenue: { $sum: '$items.subtotal' } } },
      { $lookup: { from: 'categories', localField: '_id', foreignField: '_id', as: 'categoryDoc' } },
      { $unwind: { path: '$categoryDoc', preserveNullAndEmptyArrays: true } },
      { $sort: { revenue: -1 } },
      { $limit: 8 },
      {
        $project: {
          _id: 0,
          categoryId: '$_id',
          categoryName: { $ifNull: ['$categoryDoc.name', 'Uncategorized'] },
          unitsSold: 1,
          revenue: 1,
        },
      },
    ]),

    Product.aggregate([
      { $match: { status: 'active', ratingCount: { $gt: 0 } } },
      { $sort: { ratingAverage: -1, ratingCount: -1 } },
      { $limit: 8 },
      { $lookup: { from: 'sellers', localField: 'seller', foreignField: '_id', as: 'sellerDoc' } },
      { $unwind: { path: '$sellerDoc', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          name: 1,
          images: 1,
          ratingAverage: 1,
          ratingCount: 1,
          sellerName: '$sellerDoc.businessName',
        },
      },
    ]),

    Order.aggregate([
      { $unwind: '$items' },
      { $match: { 'items.sellerOrderStatus': { $ne: 'awaiting_seller' } } },
      {
        $group: {
          _id: '$items.seller',
          totalItems: { $sum: 1 },
          returnedItems: { $sum: { $cond: [{ $in: ['$items.sellerOrderStatus', RETURN_STATUSES] }, 1, 0] } },
          revenue: { $sum: '$items.subtotal' },
        },
      },
      { $match: { totalItems: { $gte: 3 } } }, // enough volume for a return rate to mean anything
      { $lookup: { from: 'sellers', localField: '_id', foreignField: '_id', as: 'sellerDoc' } },
      { $unwind: '$sellerDoc' },
      {
        $project: {
          _id: 0,
          sellerId: '$_id',
          businessName: '$sellerDoc.businessName',
          totalItems: 1,
          returnedItems: 1,
          revenue: 1,
          returnRate: { $divide: ['$returnedItems', '$totalItems'] },
        },
      },
      { $sort: { returnRate: -1 } },
      { $limit: 8 },
    ]),
  ]);

  res.json({
    range: { start: rangeStart, end: rangeEnd },
    revenueByDay,
    categoryDemand,
    topLovedProducts,
    sellerReturnRates,
  });
});

module.exports = { getDashboard, getNeedsAttention, retryShipmentJob, getBadgeCounts, getAnalytics };
