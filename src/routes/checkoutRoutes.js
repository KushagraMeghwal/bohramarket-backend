const express = require('express');
const { getShippingEstimate } = require('../controllers/checkoutController');
const { verifyToken } = require('../middleware/authMiddleware');

const router = express.Router();

// Any authenticated buyer can price their own cart — no role restriction
// beyond being logged in, same as the cart/order endpoints.
router.post('/shipping-estimate', verifyToken, getShippingEstimate);

module.exports = router;
