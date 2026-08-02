const express = require('express');
const { getAddresses, addAddress, updateAddress, deleteAddress, setDefaultAddress } = require('../controllers/addressController');
const { verifyToken } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(verifyToken);

router.get('/', getAddresses);
router.post('/', addAddress);
router.patch('/:addressId', updateAddress);
router.delete('/:addressId', deleteAddress);
router.patch('/:addressId/default', setDefaultAddress);

module.exports = router;
