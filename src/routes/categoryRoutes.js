const express = require('express');
const {
  createCategory,
  getCategories,
  getCategoryById,
  updateCategory,
  deleteCategory,
} = require('../controllers/categoryController');
const { verifyToken, optionalAuth, requireRole } = require('../middleware/authMiddleware');
const { uploadCategoryImage } = require('../middleware/uploadMiddleware');

const router = express.Router();

router.get('/', optionalAuth, getCategories);
router.get('/:id', getCategoryById);

router.post('/', verifyToken, requireRole(['admin']), uploadCategoryImage.single('image'), createCategory);
router.put('/:id', verifyToken, requireRole(['admin']), uploadCategoryImage.single('image'), updateCategory);
router.delete('/:id', verifyToken, requireRole(['admin']), deleteCategory);

module.exports = router;
