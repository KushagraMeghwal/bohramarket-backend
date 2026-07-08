const express = require('express');
const { getHomepageContent, updateHomepageContent, uploadHomepageImage } = require('../controllers/homepageController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const { uploadHomepageMedia } = require('../middleware/uploadMiddleware');

const router = express.Router();

router.get('/', getHomepageContent);
router.put('/', verifyToken, requireRole(['admin']), updateHomepageContent);
router.post('/upload-image', verifyToken, requireRole(['admin']), uploadHomepageMedia.single('image'), uploadHomepageImage);

module.exports = router;
