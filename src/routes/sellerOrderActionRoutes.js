const express = require('express');
const { getPendingSellerItems, acceptSellerItem, rejectSellerItem } = require('../controllers/sellerOrderActionController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(verifyToken, requireRole(['seller']));

router.get('/pending', getPendingSellerItems);
router.post('/:orderId/items/:itemId/accept', acceptSellerItem);
router.post('/:orderId/items/:itemId/reject', rejectSellerItem);

module.exports = router;
