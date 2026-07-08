const Seller = require('../models/Seller');
const Product = require('../models/Product');
const Order = require('../models/Order');
const asyncHandler = require('../utils/asyncHandler');

const getDashboard = asyncHandler(async (req, res) => {
  const [sellerCounts, productCounts, totalOrders, revenueAgg, pendingSellers, pendingProducts] = await Promise.all([
    Seller.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Product.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Order.countDocuments(),
    Order.aggregate([
      { $match: { paymentStatus: { $ne: 'failed' } } },
      { $group: { _id: null, totalRevenue: { $sum: '$totalAmount' } } },
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

module.exports = { getDashboard };
