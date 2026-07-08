const express = require('express');
const {
  getCart,
  addItem,
  updateItemQuantity,
  removeItem,
  clearCart,
} = require('../controllers/cartController');
const { verifyToken } = require('../middleware/authMiddleware');

const router = express.Router();

// Cart is server-side only for logged-in users; guests use a frontend-only
// cart (see TODO in models/Cart.js for the login-time merge, not built yet).
router.use(verifyToken);

router.get('/', getCart);
router.post('/items', addItem);
router.put('/items/:productId', updateItemQuantity);
router.delete('/items/:productId', removeItem);
router.delete('/', clearCart);

module.exports = router;
