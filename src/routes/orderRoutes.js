const express = require('express');
const {
  createOrder,
  getOrders,
  getOrderById,
  verifyPayment,
  markCodPaid,
  updateItemStatus,
  adminUpdateOrderStatus,
  updateRefundStatus,
  cancelOrder,
  requestReturn,
  trackOrder,
} = require('../controllers/orderController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(verifyToken);

// A seller or admin account is still a person who might want to buy
// something — the frontend warns them first (they're placing the order as
// themselves, not "as a seller"), but the API itself doesn't need to be the
// one enforcing "shoppers only". Sellers/admins can't *sell to themselves*
// or anything like that; this only ever affects the buyer side.
const BUYER_ROLES = ['customer', 'seller', 'admin'];

router.post('/', requireRole(BUYER_ROLES), createOrder);
router.get('/', getOrders);
router.get('/:id', getOrderById);
router.get('/:id/track', trackOrder);
router.post('/:id/verify-payment', requireRole(BUYER_ROLES), verifyPayment);
router.patch('/:id/mark-cod-paid', requireRole(['seller', 'admin']), markCodPaid);
router.patch('/:id/items/:itemId/status', requireRole(['seller', 'admin']), updateItemStatus);
router.patch('/:id/admin-status', requireRole(['admin']), adminUpdateOrderStatus);
router.patch('/:id/refund-status', requireRole(['admin']), updateRefundStatus);
router.patch('/:id/cancel', requireRole(BUYER_ROLES), cancelOrder);
router.post('/:id/return', requireRole(BUYER_ROLES), requestReturn);

module.exports = router;
