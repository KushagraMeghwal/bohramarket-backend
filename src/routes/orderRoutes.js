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
} = require('../controllers/orderController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(verifyToken);

router.post('/', requireRole(['customer']), createOrder);
router.get('/', getOrders);
router.get('/:id', getOrderById);
router.post('/:id/verify-payment', requireRole(['customer']), verifyPayment);
router.patch('/:id/mark-cod-paid', requireRole(['seller', 'admin']), markCodPaid);
router.patch('/:id/items/:itemId/status', requireRole(['seller', 'admin']), updateItemStatus);
router.patch('/:id/admin-status', requireRole(['admin']), adminUpdateOrderStatus);
router.patch('/:id/refund-status', requireRole(['admin']), updateRefundStatus);
router.patch('/:id/cancel', requireRole(['customer', 'admin']), cancelOrder);

module.exports = router;
