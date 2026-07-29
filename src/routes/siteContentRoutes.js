const express = require('express');
const { getSiteContent, saveSiteContent, uploadSiteContentImage } = require('../controllers/siteContentController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const { uploadSiteContentMedia } = require('../middleware/uploadMiddleware');

const router = express.Router();

router.get('/', getSiteContent);
router.put('/', verifyToken, requireRole(['admin']), saveSiteContent);
router.post('/upload-image', verifyToken, requireRole(['admin']), uploadSiteContentMedia.single('image'), uploadSiteContentImage);

module.exports = router;
