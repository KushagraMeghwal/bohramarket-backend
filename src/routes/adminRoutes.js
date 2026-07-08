const express = require('express');
const { getDashboard } = require('../controllers/adminController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(verifyToken, requireRole(['admin']));

router.get('/dashboard', getDashboard);

module.exports = router;
