const express = require('express');
const { getReviews, getMyReviewsForOrder, createReview } = require('../controllers/reviewController');
const { verifyToken } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/', getReviews);
router.get('/mine', verifyToken, getMyReviewsForOrder);
router.post('/', verifyToken, createReview);

module.exports = router;
