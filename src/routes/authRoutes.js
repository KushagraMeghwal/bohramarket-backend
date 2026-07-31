const express = require('express');
const { register, login, googleAuth, logout, getMe, updateMe } = require('../controllers/authController');
const { verifyToken } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.post('/google', googleAuth);
router.post('/logout', logout);
router.get('/me', verifyToken, getMe);
router.patch('/me', verifyToken, updateMe);

module.exports = router;
