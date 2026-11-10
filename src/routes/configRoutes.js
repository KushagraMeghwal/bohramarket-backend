const express = require('express');
const { FLAT_SHIPPING_FEE, FREE_SHIPPING_THRESHOLD, RETURN_WINDOW_DAYS, MAX_QTY_PER_ITEM } = require('../config/shop');
const { isRazorpayConfigured } = require('../config/env');

const router = express.Router();

// GET /api/config — public storefront settings, so the frontend reads them
// from the same source checkout uses instead of hardcoding its own copies.
router.get('/', (req, res) => {
  res.json({
    freeShippingThreshold: FREE_SHIPPING_THRESHOLD,
    flatShippingFee: FLAT_SHIPPING_FEE,
    returnWindowDays: RETURN_WINDOW_DAYS,
    maxQtyPerItem: MAX_QTY_PER_ITEM,
    onlinePaymentsEnabled: isRazorpayConfigured(),
  });
});

module.exports = router;
