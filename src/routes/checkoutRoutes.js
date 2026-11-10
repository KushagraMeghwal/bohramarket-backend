const express = require('express');
const { getShippingEstimate, getDeliveryEstimate } = require('../controllers/checkoutController');
const { verifyToken } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/shipping-estimate', verifyToken, getShippingEstimate);
router.get('/delivery-estimate', getDeliveryEstimate);

module.exports = router;
