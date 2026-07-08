const express = require('express');
const {
  applySeller,
  getSellers,
  getMySellerProfile,
  getSellerById,
  approveSeller,
  rejectSeller,
  suspendSeller,
  getMyStats,
  getMyEarnings,
} = require('../controllers/sellerController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const { uploadSellerDocuments } = require('../middleware/uploadMiddleware');

const router = express.Router();

router.use(verifyToken);

router.post(
  '/apply',
  requireRole(['customer', 'seller']),
  uploadSellerDocuments.fields([
    { name: 'pan', maxCount: 1 },
    { name: 'gst', maxCount: 1 },
    { name: 'aadhaar', maxCount: 1 },
    { name: 'bank_proof', maxCount: 1 },
    { name: 'other', maxCount: 3 },
  ]),
  applySeller
);

router.get('/me', requireRole(['seller']), getMySellerProfile);
router.get('/me/stats', requireRole(['seller']), getMyStats);
router.get('/me/earnings', requireRole(['seller']), getMyEarnings);
router.get('/', requireRole(['admin']), getSellers);
router.get('/:id', requireRole(['admin']), getSellerById);
router.patch('/:id/approve', requireRole(['admin']), approveSeller);
router.patch('/:id/reject', requireRole(['admin']), rejectSeller);
router.patch('/:id/suspend', requireRole(['admin']), suspendSeller);

module.exports = router;
