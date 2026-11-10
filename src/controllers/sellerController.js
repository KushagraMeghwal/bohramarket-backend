const User = require('../models/User');
const Seller = require('../models/Seller');
const Order = require('../models/Order');
const Product = require('../models/Product');
const { respondByFor } = require('../services/sellerResponseWindow.service');
const asyncHandler = require('../utils/asyncHandler');
const { registerShiprocketPickup } = require('../services/sellerPickupRegistration.service');
const cloudinary = require('../config/cloudinary');
const { decrypt, isMasked } = require('../utils/fieldCrypto');

const AADHAAR_PATTERN = /^\d{12}$/;
const PAN_PATTERN = /^[A-Z]{5}\d{4}[A-Z]$/;
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const DOCUMENT_LINK_TTL_SECONDS = 10 * 60;
const CANCELLED_ITEM_STATUSES = ['cancelled', 'rto'];

// Cloudinary's secure_url carries the resource type and extension:
// https://res.cloudinary.com/<cloud>/<resource_type>/<type>/v123/<public_id>.<format>
function describeUpload(file) {
  const match = String(file.path || '').match(/\/(image|raw|video)\/(upload|private|authenticated)\/.*\.([a-z0-9]+)(?:\?|$)/i);
  return {
    resourceType: match ? match[1] : 'image',
    deliveryType: match && match[2] === 'private' ? 'private' : 'upload',
    format: match ? match[3].toLowerCase() : undefined,
  };
}

// Full Aadhaar / account number, decrypted — admin KYC review only.
function revealSensitive(seller) {
  return {
    aadhaarNumber: decrypt(seller.aadhaarNumber) || null,
    accountNumber: decrypt(seller.bankDetails?.accountNumber) || null,
  };
}

function validateKyc({ panNumber, aadhaarNumber, bankDetails }) {
  if (panNumber && !PAN_PATTERN.test(String(panNumber).toUpperCase())) return 'PAN must look like ABCDE1234F';
  if (aadhaarNumber && !AADHAAR_PATTERN.test(String(aadhaarNumber).replace(/\s/g, ''))) return 'Aadhaar number must be 12 digits';
  if (bankDetails?.ifscCode && !IFSC_PATTERN.test(String(bankDetails.ifscCode).toUpperCase())) return 'IFSC code looks invalid';
  if (bankDetails?.accountNumber && !isMasked(bankDetails.accountNumber) && !/^\d{9,18}$/.test(String(bankDetails.accountNumber))) {
    return 'Bank account number must be 9-18 digits';
  }
  return null;
}

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
  const kycError = validateKyc({ panNumber, aadhaarNumber, bankDetails: parseIfJson(bankDetails) });
  if (kycError) {
    return res.status(400).json({ message: kycError });
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
      // Cloudinary returns private assets with a permanent signature baked
      // into the URL (/s--xxxx--/). Store it unsigned, so the database never
      // holds a working link; viewing goes through getDocumentUrl.
      const unsignedUrl = String(file.path).replace(/\/s--[^/]+--\//, '/');
      documents.push({ type: fieldName, url: unsignedUrl, publicId: file.filename, ...describeUpload(file) });
    });
  });

  const fields = {
    businessName,
    businessType,
    gstNumber,
    panNumber: panNumber ? String(panNumber).toUpperCase() : panNumber,
    aadhaarNumber: aadhaarNumber ? String(aadhaarNumber).replace(/\s/g, '') : aadhaarNumber,
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
  res.json({ seller, sensitive: revealSensitive(seller) });
});

// PATCH /api/sellers/me
// Lets an already-onboarded seller edit their editable business details.
// GST/PAN/Aadhaar/documents/status are intentionally excluded — those are
// KYC-verified fields and changing them here would bypass admin review.
const updateMyProfile = asyncHandler(async (req, res) => {
  const seller = await Seller.findOne({ user: req.user._id });
  if (!seller) {
    return res.status(404).json({ message: 'Seller profile not found' });
  }

  const { businessName, contactPhone, pickupAddress, bankDetails } = req.body;

  if (!businessName || !contactPhone || !pickupAddress) {
    return res.status(400).json({ message: 'Missing required business details' });
  }

  const newPickupAddress = parseIfJson(pickupAddress);
  const oldPickupAddress = seller.pickupAddress?.toObject ? seller.pickupAddress.toObject() : seller.pickupAddress;
  const pickupAddressChanged = JSON.stringify(oldPickupAddress) !== JSON.stringify(newPickupAddress);

  const newBankDetails = bankDetails ? parseIfJson(bankDetails) : null;
  const kycError = validateKyc({ bankDetails: newBankDetails });
  if (kycError) {
    return res.status(400).json({ message: kycError });
  }

  seller.businessName = businessName;
  seller.contactPhone = contactPhone;
  seller.pickupAddress = newPickupAddress;
  if (newBankDetails) {
    // The profile form only ever sees the masked number ("XXXXXX1234"); when
    // it comes back unchanged, keep the stored (encrypted) value.
    if (!newBankDetails.accountNumber || isMasked(newBankDetails.accountNumber)) {
      newBankDetails.accountNumber = seller.bankDetails?.accountNumber;
    }
    seller.bankDetails = newBankDetails;
  }

  if (pickupAddressChanged) {
    // The old Shiprocket pickup location (registered off the *previous*
    // address — see shiprocket.service.js ensurePickupLocation()) no longer
    // matches. PART 2.10: instead of just clearing it and leaving the
    // seller to discover whether the new address works only when their next
    // order silently fails, register fresh against the new address right
    // now and report the result.
    seller.shiprocketPickupLocationName = undefined;
    seller.shiprocketPickupStatus = 'not_registered';
    await seller.save();
    await registerShiprocketPickup(seller);
  } else {
    await seller.save();
  }

  res.json({ seller });
});

// POST /api/sellers/me/retry-pickup-registration
// Manual retry for the "Failed" pickup-registration badge on the seller's
// own profile page — same underlying function the automatic paths use
// (approval, address change, first accepted order), just triggered on
// demand instead of by one of those events.
const retryPickupRegistration = asyncHandler(async (req, res) => {
  const seller = await Seller.findOne({ user: req.user._id });
  if (!seller) {
    return res.status(404).json({ message: 'Seller profile not found' });
  }

  let result;
  try {
    result = await registerShiprocketPickup(seller);
  } catch (err) {
    // registerShiprocketPickup is designed to never throw — it catches every
    // Shiprocket/network failure itself and returns {success: false, ...}
    // (see sellerPickupRegistration.service.js). This is a defensive
    // backstop only, so a future change there can never turn into an
    // unhandled rejection reaching asyncHandler as a bare 500/502.
    console.error(`[retry-pickup-registration] unexpected error for seller ${seller._id}:`, err);
    return res.status(500).json({ message: 'Could not retry pickup registration. Please try again.' });
  }

  if (!result.success) {
    // A rejected address is a client-fixable validation problem (bad/
    // incomplete pickup address), not an upstream gateway failure — 502
    // told the frontend "something's broken on our end" when the real
    // answer is "fix this field". 422 when a specific field was identified,
    // 400 for a less structured Shiprocket rejection.
    const status = result.field ? 422 : 400;
    return res.status(status).json({ message: result.error, field: result.field ?? null, seller });
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

  // PART 2.10: register the Shiprocket pickup location now, not lazily on
  // the seller's first order — surfaces a broken pickup address (bad
  // address data, Shiprocket account issue) while an admin is already
  // looking at this seller in the approval flow, instead of it silently
  // failing days later on a real customer order. Never blocks the approval
  // response either way — registerShiprocketPickup handles its own
  // success/failure bookkeeping and notification.
  await registerShiprocketPickup(seller);

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

      if (item.itemStatus === 'rto' || ['return_requested', 'return_picked'].includes(item.sellerOrderStatus)) pendingReturns += 1;

      const unpaidOnline = order.paymentMethod === 'online' && order.paymentStatus !== 'paid';
      if (!CANCELLED_ITEM_STATUSES.includes(item.itemStatus) && !unpaidOnline) {
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
        // Cancelled, rejected, returned or never-paid items earn nothing —
        // they used to be counted, inflating the seller's earnings.
        const unpaidOnline = order.paymentMethod === 'online' && order.paymentStatus === 'pending';
        const excluded =
          CANCELLED_ITEM_STATUSES.includes(item.itemStatus) || item.sellerOrderStatus === 'return_delivered' || unpaidOnline;
        if (excluded) return;

        const commission = Math.round(item.subtotal * (COMMISSION_PERCENT / 100) * 100) / 100;
        const netEarning = Math.round((item.subtotal - commission) * 100) / 100;
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
          payoutStatus: item.itemStatus === 'delivered' && order.paymentStatus === 'paid' ? 'pending_payout' : 'awaiting_delivery',
          createdAt: order.createdAt,
        });
      });
  });

  res.json({ ledger, totalNetEarning: Math.round(totalNetEarning * 100) / 100, commissionPercent: COMMISSION_PERCENT });
});

// GET /api/sellers/me/notifications
// Counts behind the seller portal's sidebar badges and notification bell —
// everything a seller needs to act on, cheap enough to poll every minute.
const getMyNotifications = asyncHandler(async (req, res) => {
  const seller = await Seller.findOne({ user: req.user._id }).select('_id status shiprocketPickupStatus shiprocketPickupError');
  if (!seller) {
    return res.status(404).json({ message: 'Seller profile not found' });
  }

  const [awaiting, toShip, inReview, rejected, lowStock, outOfStock] = await Promise.all([
    Order.aggregate([
      { $match: { 'items.seller': seller._id } },
      { $unwind: '$items' },
      // Online orders only count once paid — the seller can't accept before that.
      { $match: { 'items.seller': seller._id, 'items.sellerOrderStatus': 'awaiting_seller', $or: [{ paymentMethod: 'COD' }, { paymentStatus: 'paid' }] } },
      { $group: { _id: null, count: { $sum: 1 }, oldest: { $min: { $ifNull: ['$paidAt', '$createdAt'] } } } },
    ]),
    Order.aggregate([
      { $match: { 'items.seller': seller._id } },
      { $unwind: '$items' },
      { $match: { 'items.seller': seller._id, 'items.sellerOrderStatus': { $in: ['accepted', 'confirmed', 'ready_to_ship'] }, 'items.itemStatus': { $in: ['placed', 'packed'] } } },
      { $count: 'count' },
    ]),
    Product.countDocuments({ seller: seller._id, status: 'pending_review' }),
    Product.countDocuments({ seller: seller._id, status: 'rejected' }),
    Product.countDocuments({ seller: seller._id, status: 'active', stock: { $gt: 0, $lte: 5 } }),
    Product.countDocuments({ seller: seller._id, status: 'active', stock: 0 }),
  ]);

  const awaitingCount = awaiting[0]?.count || 0;
  const respondBy = awaitingCount ? respondByFor({ createdAt: awaiting[0].oldest }) : null;

  res.json({
    orders: { awaitingResponse: awaitingCount, toShip: toShip[0]?.count || 0, oldestRespondBy: respondBy },
    products: { inReview, rejected, lowStock, outOfStock },
    pickupRegistrationFailed: seller.shiprocketPickupStatus === 'failed',
    pickupError: seller.shiprocketPickupStatus === 'failed' ? seller.shiprocketPickupError : undefined,
  });
});

// GET /api/sellers/:id/documents/:docId/url (admin)
// GET /api/sellers/me/documents/:docId/url (the seller themselves)
// Returns a download link that expires after DOCUMENT_LINK_TTL_SECONDS.
const getDocumentUrl = asyncHandler(async (req, res) => {
  const seller = req.params.id
    ? await Seller.findById(req.params.id)
    : await Seller.findOne({ user: req.user._id });
  if (!seller) {
    return res.status(404).json({ message: 'Seller not found' });
  }
  const doc = seller.documents.id(req.params.docId);
  if (!doc) {
    return res.status(404).json({ message: 'Document not found' });
  }

  const format = doc.format || (doc.url.match(/\.([a-z0-9]+)(?:\?|$)/i) || [])[1] || 'jpg';
  const url = cloudinary.utils.private_download_url(doc.publicId, format, {
    resource_type: doc.resourceType || 'image',
    type: doc.deliveryType === 'private' ? 'private' : 'upload',
    expires_at: Math.floor(Date.now() / 1000) + DOCUMENT_LINK_TTL_SECONDS,
  });

  res.json({ url, expiresInSeconds: DOCUMENT_LINK_TTL_SECONDS });
});

module.exports = {
  getMyNotifications,
  getDocumentUrl,
  applySeller,
  getSellers,
  getMySellerProfile,
  updateMyProfile,
  retryPickupRegistration,
  getSellerById,
  approveSeller,
  rejectSeller,
  suspendSeller,
  getMyStats,
  getMyEarnings,
};
