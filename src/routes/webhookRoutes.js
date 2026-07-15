const express = require('express');
const { handleRazorpayWebhook } = require('../controllers/webhookController');

const router = express.Router();

// express.raw() here (not express.json()) is what makes signature
// verification possible — see server.js for why this router must be
// mounted before the app-wide express.json() middleware.
router.post('/razorpay', express.raw({ type: '*/*' }), handleRazorpayWebhook);

module.exports = router;
