const Seller = require('../models/Seller');
const asyncHandler = require('../utils/asyncHandler');

// Blocks product create/edit unless the caller is an admin or an approved
// seller. Attaches req.seller for approved sellers so controllers don't
// need to re-query it.
const requireApprovedSeller = asyncHandler(async (req, res, next) => {
  if (req.user.role === 'admin') return next();

  const seller = await Seller.findOne({ user: req.user._id });

  if (!seller || seller.status !== 'approved') {
    return res.status(403).json({ message: 'Only approved sellers can perform this action' });
  }

  req.seller = seller;
  next();
});

module.exports = { requireApprovedSeller };
