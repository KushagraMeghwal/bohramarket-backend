const mongoose = require('mongoose');
const Review = require('../models/Review');
const Order = require('../models/Order');
const Product = require('../models/Product');
const asyncHandler = require('../utils/asyncHandler');

// Recomputes the product's rating from its reviews, so ratingAverage /
// ratingCount (used by "Top Rated", sorting and the rating filter) are real.
async function refreshProductRating(productId) {
  const [stats] = await Review.aggregate([
    { $match: { product: new mongoose.Types.ObjectId(String(productId)) } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  await Product.findByIdAndUpdate(productId, {
    ratingAverage: stats ? Math.round(stats.avg * 10) / 10 : 0,
    ratingCount: stats ? stats.count : 0,
  });
}

// GET /api/reviews?product=<id>&page=&limit=
const getReviews = asyncHandler(async (req, res) => {
  const { product } = req.query;

  if (!product || !mongoose.isValidObjectId(product)) {
    return res.status(400).json({ message: 'product query param is required' });
  }

  const pageNum = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limitNum = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const skip = (pageNum - 1) * limitNum;

  const [reviews, total] = await Promise.all([
    Review.find({ product })
      .populate('customer', 'name avatarUrl')
      .sort('-createdAt')
      .skip(skip)
      .limit(limitNum),
    Review.countDocuments({ product }),
  ]);

  res.json({ reviews, total, page: pageNum, limit: limitNum });
});

// GET /api/reviews/mine?order=<id> — which products in this order the
// customer has already reviewed (drives the order page's review buttons).
const getMyReviewsForOrder = asyncHandler(async (req, res) => {
  const { order } = req.query;
  if (!order || !mongoose.isValidObjectId(order)) {
    return res.status(400).json({ message: 'order query param is required' });
  }
  const reviews = await Review.find({ order, customer: req.user._id }).select('product rating title comment createdAt');
  res.json({ reviews });
});

// POST /api/reviews — verified purchases only: the item must be in one of
// this customer's orders and delivered. One review per product per order.
const createReview = asyncHandler(async (req, res) => {
  const { orderId, productId, title, comment } = req.body;
  const rating = Number(req.body.rating);

  if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(productId)) {
    return res.status(400).json({ message: 'orderId and productId are required' });
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ message: 'Rating must be a whole number from 1 to 5' });
  }
  if (typeof comment !== 'string' || comment.trim().length < 3) {
    return res.status(400).json({ message: 'Please write a short review (at least 3 characters)' });
  }

  const order = await Order.findOne({ _id: orderId, customer: req.user._id });
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }
  const item = order.items.find((i) => String(i.product) === String(productId));
  if (!item) {
    return res.status(400).json({ message: 'This product is not part of that order' });
  }
  if (item.itemStatus !== 'delivered') {
    return res.status(400).json({ message: 'You can review this item once it has been delivered' });
  }

  const existing = await Review.findOne({ product: productId, customer: req.user._id, order: orderId });
  if (existing) {
    return res.status(409).json({ message: 'You have already reviewed this item' });
  }

  const review = await Review.create({
    product: productId,
    customer: req.user._id,
    order: orderId,
    rating,
    title: typeof title === 'string' ? title.trim().slice(0, 120) : undefined,
    comment: comment.trim().slice(0, 2000),
  });

  await refreshProductRating(productId);
  await review.populate('customer', 'name avatarUrl');
  res.status(201).json({ review });
});

module.exports = { getReviews, getMyReviewsForOrder, createReview, refreshProductRating };
