const express = require('express');
const { handleRazorpayWebhook, handleShiprocketWebhook } = require('../controllers/webhookController');

const router = express.Router();

// express.raw() here (not express.json()) is what makes signature
// verification possible — see server.js for why this router must be
// mounted before the app-wide express.json() middleware.
router.post('/razorpay', express.raw({ type: '*/*' }), handleRazorpayWebhook);

// Shiprocket doesn't sign its webhook body the way Razorpay does, so there's
// no need for the raw buffer here — but since this whole router is mounted
// before the app's global express.json() (see server.js), this route needs
// its own JSON parser or req.body would arrive unparsed.
router.post('/shiprocket', express.json(), handleShiprocketWebhook);

module.exports = router;
