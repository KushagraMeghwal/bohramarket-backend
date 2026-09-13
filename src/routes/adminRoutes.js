const express = require('express');
const { getDashboard, getNeedsAttention, retryShipmentJob, getBadgeCounts, getAnalytics } = require('../controllers/adminController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(verifyToken, requireRole(['admin']));

router.get('/dashboard', getDashboard);
router.get('/needs-attention', getNeedsAttention);
router.get('/badge-counts', getBadgeCounts);
router.get('/analytics', getAnalytics);
router.post('/shipment-jobs/:id/retry', retryShipmentJob);

module.exports = router;
