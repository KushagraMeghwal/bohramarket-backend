const express = require('express');
const {
  createProduct,
  getProducts,
  getProductById,
  updateProduct,
  deleteProduct,
  approveProduct,
  rejectProduct,
  deactivateProduct,
  reactivateProduct,
} = require('../controllers/productController');
const { verifyToken, optionalAuth, requireRole } = require('../middleware/authMiddleware');
const { requireApprovedSeller } = require('../middleware/sellerMiddleware');
const { uploadProductMedia } = require('../middleware/uploadMiddleware');

const router = express.Router();

router.get('/', optionalAuth, getProducts);
router.get('/:id', optionalAuth, getProductById);

router.post(
  '/',
  verifyToken,
  requireRole(['seller']),
  requireApprovedSeller,
  uploadProductMedia.array('images', 6),
  createProduct
);
router.put(
  '/:id',
  verifyToken,
  requireRole(['seller', 'admin']),
  requireApprovedSeller,
  uploadProductMedia.array('images', 6),
  updateProduct
);
router.delete('/:id', verifyToken, requireRole(['seller', 'admin']), deleteProduct);

router.patch('/:id/deactivate', verifyToken, requireRole(['seller', 'admin']), deactivateProduct);
router.patch('/:id/reactivate', verifyToken, requireRole(['seller', 'admin']), reactivateProduct);

router.patch('/:id/approve', verifyToken, requireRole(['admin']), approveProduct);
router.patch('/:id/reject', verifyToken, requireRole(['admin']), rejectProduct);

module.exports = router;
