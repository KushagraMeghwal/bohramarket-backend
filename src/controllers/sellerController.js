const User = require('../models/User');
const Seller = require('../models/Seller');
const Order = require('../models/Order');
const asyncHandler = require('../utils/asyncHandler');

const COMMISSION_PERCENT = Number(process.env.PLATFORM_COMMISSION_PERCENT) || 0;

const parseIfJson = (value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return value;
  }
};

// POST /api/sellers/apply
// Reachable by both customers (applying for the first time) and sellers
// (already flipped to 'seller' by an earlier application). A 'rejected'
// application can be resubmitted in place; pending/approved/suspended cannot.
const applySeller = asyncHandler(async (req, res) => {
  const existing = await Seller.findOne({ user: req.user._id });
  if (existing && existing.status !== 'rejected') {
    return res.status(409).json({ message: 'A seller application already exists for this account' });
  }

  const { businessName, businessType, gstNumber, panNumber, aadhaarNumber, contactPhone, pickupAddress, bankDetails } = req.body;

  if (!businessName || !contactPhone || !pickupAddress) {
    return res.status(400).json({ message: 'Missing required business details' });
  }

  // Every applicant proves identity (PAN + Aadhaar) and a business/bank
  // proof — no optional-vs-mandatory distinction, all three are required.
  const REQUIRED_DOCUMENT_FIELDS = ['pan', 'aadhaar', 'bank_proof'];
  const missingDocuments = REQUIRED_DOCUMENT_FIELDS.filter((field) => !req.files?.[field]?.length);
  if (missingDocuments.length) {
    return res.status(400).json({ message: `Missing required documents: ${missingDocuments.join(', ')}` });
  }

  const documents = [];
  Object.entries(req.files).forEach(([fieldName, files]) => {
    files.forEach((file) => {
      documents.push({ type: fieldName, url: file.path, publicId: file.filename });
    });
  });

  const fields = {
    businessName,
    businessType,
    gstNumber,
    panNumber,
    aadhaarNumber,
    contactPhone,
    pickupAddress: parseIfJson(pickupAddress),
    bankDetails: parseIfJson(bankDetails),
    documents,
    status: 'pending',
    rejectionReason: undefined,
    reviewedBy: undefined,
    reviewedAt: undefined,
  };

  const seller = existing
    ? await Object.assign(existing, fields).save()
    : await Seller.create({ user: req.user._id, ...fields });

  if (req.user.role !== 'seller') {
    await User.findByIdAndUpdate(req.user._id, { role: 'seller' });
  }

  res.status(existing ? 200 : 201).json({ seller });
});

// GET /api/sellers
const getSellers = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const filter = {};
  if (status) filter.status = status;

  const sellers = await Seller.find(filter).populate('user', 'name email phone').sort('-createdAt');
  res.json({ sellers });
});

// GET /api/sellers/me
const getMySellerProfile = asyncHandler(async (req, res) => {
  const seller = await Seller.findOne({ user: req.user._id });
  if (!seller) {
    return res.status(404).json({ message: 'Seller profile not found' });
  }
  res.json({ seller });
});

// GET /api/sellers/:id
const getSellerById = asyncHandler(async (req, res) => {
  const seller = await Seller.findById(req.params.id).populate('user', 'name email phone');
  if (!seller) {
    return res.status(404).json({ message: 'Seller not found' });
  }
  res.json({ seller });
});

// PATCH /api/sellers/:id/approve
const approveSeller = asyncHandler(async (req, res) => {
  const seller = await Seller.findByIdAndUpdate(
    req.params.id,
    {
      status: 'approved',
      rejectionReason: undefined,
      reviewedBy: req.user._id,
      reviewedAt: new Date(),
    },
    { returnDocument: 'after' }
  );

  if (!seller) {
    return res.status(404).json({ message: 'Seller not found' });
  }

  res.json({ seller });
});

// PATCH /api/sellers/:id/reject
const rejectSeller = asyncHandler(async (req, res) => {
  const { reason } = req.body;

  if (!reason) {
    return res.status(400).json({ message: 'A rejectionReason is required' });
  }

  const seller = await Seller.findByIdAndUpdate(
    req.params.id,
    {
      status: 'rejected',
      rejectionReason: reason,
      reviewedBy: req.user._id,
      reviewedAt: new Date(),
    },
    { returnDocument: 'after' }
  );

  if (!seller) {
    return res.status(404).json({ message: 'Seller not found' });
  }

  res.json({ seller });
});

// PATCH /api/sellers/:id/suspend
const suspendSeller = asyncHandler(async (req, res) => {
  const { reason } = req.body;

  if (!reason) {
    return res.status(400).json({ message: 'A suspension reason is required' });
  }

  const seller = await Seller.findByIdAndUpdate(
    req.params.id,
    {
      status: 'suspended',
      rejectionReason: reason,
      reviewedBy: req.user._id,
      reviewedAt: new Date(),
    },
    { returnDocument: 'after' }
  );

  if (!seller) {
    return res.status(404).json({ message: 'Seller not found' });
  }

  res.json({ seller });
});

// GET /api/sellers/me/stats
// "Customer Questions" has no backend Q&A feature yet, so it's not included
// here — the frontend shows a flagged 0/placeholder for it instead of
// inventing a number.
const getMyStats = asyncHandler(async (req, res) => {
  const seller = await Seller.findOne({ user: req.user._id });
  if (!seller) {
    return res.status(404).json({ message: 'Seller profile not found' });
  }

  const orders = await Order.find({ 'items.seller': seller._id });

  let totalRevenue = 0;
  let pendingReturns = 0;
  const orderIds = new Set();
  const salesByMonth = {};

  orders.forEach((order) => {
    let sellerHasItem = false;

    order.items.forEach((item) => {
      if (String(item.seller) !== String(seller._id)) return;
      sellerHasItem = true;

      if (item.itemStatus === 'rto') pendingReturns += 1;

      if (item.itemStatus !== 'cancelled' && item.itemStatus !== 'rto') {
        totalRevenue += item.subtotal;
        const monthKey = order.createdAt.toISOString().slice(0, 7);
        salesByMonth[monthKey] = (salesByMonth[monthKey] || 0) + item.subtotal;
      }
    });

    if (sellerHasItem) orderIds.add(String(order._id));
  });

  res.json({
    totalRevenue,
    totalOrders: orderIds.size,
    pendingReturns,
    salesByMonth: Object.entries(salesByMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, total]) => ({ month, total })),
  });
});

// GET /api/sellers/me/earnings
// Read-only ledger computed on the fly from order items — no Payout
// documents are created here, real payout batching isn't built yet.
const getMyEarnings = asyncHandler(async (req, res) => {
  const seller = await Seller.findOne({ user: req.user._id });
  if (!seller) {
    return res.status(404).json({ message: 'Seller profile not found' });
  }

  const orders = await Order.find({ 'items.seller': seller._id }).sort('-createdAt');

  const ledger = [];
  let totalNetEarning = 0;

  orders.forEach((order) => {
    order.items
      .filter((item) => String(item.seller) === String(seller._id))
      .forEach((item) => {
        const commission = Math.round(item.subtotal * (COMMISSION_PERCENT / 100) * 100) / 100;
        const netEarning = item.subtotal - commission;
        totalNetEarning += netEarning;

        ledger.push({
          orderId: order._id,
          orderNumber: order.orderNumber,
          itemName: item.name,
          subtotal: item.subtotal,
          commissionPercent: COMMISSION_PERCENT,
          commission,
          netEarning,
          itemStatus: item.itemStatus,
          paymentStatus: order.paymentStatus,
          payoutStatus: order.paymentStatus === 'paid' ? 'pending_payout' : 'awaiting_payment',
          createdAt: order.createdAt,
        });
      });
  });

  res.json({ ledger, totalNetEarning, commissionPercent: COMMISSION_PERCENT });
});

module.exports = {
  applySeller,
  getSellers,
  getMySellerProfile,
  getSellerById,
  approveSeller,
  rejectSeller,
  suspendSeller,
  getMyStats,
  getMyEarnings,
};
