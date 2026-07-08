const Review = require('../models/Review');
const asyncHandler = require('../utils/asyncHandler');

// GET /api/reviews?product=<id>&page=&limit=
const getReviews = asyncHandler(async (req, res) => {
  const { product, page = 1, limit = 10 } = req.query;

  if (!product) {
    return res.status(400).json({ message: 'product query param is required' });
  }

  const pageNum = Number(page);
  const limitNum = Number(limit);
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

module.exports = { getReviews };
