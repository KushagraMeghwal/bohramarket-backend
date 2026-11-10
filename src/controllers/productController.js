const Product = require('../models/Product');
const Seller = require('../models/Seller');
const asyncHandler = require('../utils/asyncHandler');
const Order = require('../models/Order');

// Price rules every create/update must satisfy. A discount price at or
// above the list price (or a 0 price) is almost always a typo — e.g. a
// listed Rs 499 rida "discounted" to Rs 50.
function validatePricing({ price, discountPrice, stock }) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return 'Price must be greater than 0';
  if (discountPrice !== undefined && discountPrice !== null && discountPrice !== '') {
    const d = Number(discountPrice);
    if (!Number.isFinite(d) || d <= 0) return 'Discount price must be greater than 0';
    if (d >= p) return 'Discount price must be lower than the regular price';
  }
  if (stock !== undefined && stock !== null && stock !== '') {
    const st = Number(stock);
    if (!Number.isInteger(st) || st < 0) return 'Stock must be a whole number (0 or more)';
  }
  return null;
}

// Treats "", "null" and "undefined" from multipart forms as "no discount".
const normalizeDiscount = (value) => (value === '' || value === 'null' || value === 'undefined' ? null : value);

// Edits that change what the customer is buying need admin re-review;
// price, stock and shipping-weight changes don't (they used to pull a live
// listing off the store just for a stock top-up).
const REVIEW_FIELDS = ['name', 'description', 'category', 'attributes'];

const slugify = (name) =>
  `${name}-${Date.now()}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

// multipart/form-data (used for image uploads) sends every field as a plain
// string, so nested-object fields like `attributes`/`dimensions` arrive
// JSON-stringified from the seller form and need parsing before Mongoose
// can cast them into the schema's embedded objects.
const parseIfJson = (value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return value;
  }
};

// POST /api/products (requireApprovedSeller middleware already gated this)
const createProduct = asyncHandler(async (req, res) => {
  const {
    name,
    description,
    category,
    price,
    discountPrice,
    sku,
    stock,
    variantGroupId,
    attributes,
    weight,
    dimensions,
  } = req.body;

  if (!name || !description || !category || price == null || !sku) {
    return res.status(400).json({ message: 'Missing required product fields' });
  }
  const pricingError = validatePricing({ price, discountPrice: normalizeDiscount(discountPrice), stock });
  if (pricingError) {
    return res.status(400).json({ message: pricingError });
  }
  let images = (req.files || []).map((file) => ({ url: file.path, publicId: file.filename }));

  // A new size added to an existing listing reuses its sibling's photos
  // (the seller didn't re-upload them).
  if (!images.length && req.body.copyImagesFrom) {
    const sibling = await Product.findOne({ _id: req.body.copyImagesFrom, seller: req.seller._id }).select('images');
    images = sibling?.images?.map(({ url, publicId }) => ({ url, publicId })) || [];
  }
  if (!images.length) {
    return res.status(400).json({ message: 'Add at least one product photo' });
  }

  const product = await Product.create({
    seller: req.seller._id,
    name,
    slug: slugify(name),
    description,
    category,
    images,
    price,
    discountPrice: normalizeDiscount(discountPrice) ?? undefined,
    sku,
    stock,
    variantGroupId,
    attributes: parseIfJson(attributes),
    weight,
    dimensions: parseIfJson(dimensions),
    status: 'pending_review',
  });

  res.status(201).json({ product });
});

const SORT_OPTIONS = {
  price_asc: 'price',
  price_desc: '-price',
  rating: '-ratingAverage',
  newest: '-createdAt',
};

// GET /api/products
const getProducts = asyncHandler(async (req, res) => {
  const { category, status, seller, search, variantGroupId, minPrice, maxPrice, minRating, minDiscount, sort, mine } = req.query;

  const filter = {};
  const exprs = [];
  let scopedToOwnSeller = false;

  if (req.user?.role === 'admin') {
    if (status) filter.status = status;
  } else if (req.user?.role === 'seller' && mine === 'true') {
    // Only the seller's own dashboard/product-management pages send
    // `mine=true` — the public storefront (home, product list, product
    // detail, cart) never does, so a logged-in seller browsing as a shopper
    // still sees the full marketplace instead of just their own catalog.
    const ownSeller = await Seller.findOne({ user: req.user._id });
    if (!ownSeller) return res.json({ products: [], total: 0, page: 1, limit: 0 });
    filter.seller = ownSeller._id;
    scopedToOwnSeller = true;
    if (status) filter.status = status;
  } else {
    filter.status = 'active';
  }

  if (category) filter.category = category;
  // A seller's own-catalog view must not be widened to another seller's
  // (possibly unpublished) products via ?seller=.
  if (seller && !scopedToOwnSeller) filter.seller = seller;
  if (search) filter.$text = { $search: search };
  if (variantGroupId) filter.variantGroupId = variantGroupId;

  // Price filters/sorting use what the customer actually pays (the discount
  // price when there is one), not the struck-through list price.
  const effectivePrice = { $ifNull: ['$discountPrice', '$price'] };
  if (minPrice && Number.isFinite(Number(minPrice))) exprs.push({ $gte: [effectivePrice, Number(minPrice)] });
  if (maxPrice && Number.isFinite(Number(maxPrice))) exprs.push({ $lte: [effectivePrice, Number(maxPrice)] });
  if (minDiscount && Number.isFinite(Number(minDiscount))) {
    // (price - discountPrice) / price >= minDiscount%
    exprs.push({
      $gte: [{ $multiply: [{ $divide: [{ $subtract: ['$price', effectivePrice] }, '$price'] }, 100] }, Number(minDiscount)],
    });
  }
  if (exprs.length) filter.$expr = exprs.length === 1 ? exprs[0] : { $and: exprs };

  if (minRating) filter.ratingAverage = { $gte: Number(minRating) || 0 };

  const pageNum = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limitNum = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 60);
  const skip = (pageNum - 1) * limitNum;

  let products;
  const total = await Product.countDocuments(filter);
  if (sort === 'price_asc' || sort === 'price_desc') {
    const ids = await Product.aggregate([
      { $match: filter },
      { $addFields: { _effectivePrice: effectivePrice } },
      { $sort: { _effectivePrice: sort === 'price_asc' ? 1 : -1, _id: 1 } },
      { $skip: skip },
      { $limit: limitNum },
      { $project: { _id: 1 } },
    ]);
    const byId = new Map(
      (await Product.find({ _id: { $in: ids.map((d) => d._id) } }).populate('category', 'name slug type').populate('seller', 'businessName')).map(
        (p) => [String(p._id), p]
      )
    );
    products = ids.map((d) => byId.get(String(d._id))).filter(Boolean);
  } else {
    const sortOrder = SORT_OPTIONS[sort] || SORT_OPTIONS.newest;
    products = await Product.find(filter)
      .populate('category', 'name slug type')
      .populate('seller', 'businessName')
      .skip(skip)
      .limit(limitNum)
      .sort(sortOrder);
  }

  res.json({ products, total, page: pageNum, limit: limitNum });
});

// GET /api/products/:id
const getProductById = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id)
    .populate('category', 'name slug type')
    .populate('seller', 'businessName');

  if (!product) {
    return res.status(404).json({ message: 'Product not found' });
  }

  const isAdmin = req.user?.role === 'admin';
  const isOwner =
    req.user?.role === 'seller' &&
    String(product.seller._id) === String((await Seller.findOne({ user: req.user._id }))?._id);

  if (product.status !== 'active' && !isOwner && !isAdmin) {
    return res.status(404).json({ message: 'Product not found' });
  }

  res.json({ product });
});

// PUT /api/products/:id (requireApprovedSeller middleware already gated seller access)
const updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) {
    return res.status(404).json({ message: 'Product not found' });
  }

  if (req.user.role === 'seller' && String(product.seller) !== String(req.seller._id)) {
    return res.status(403).json({ message: 'You do not own this product' });
  }

  const editableFields = [
    'name',
    'description',
    'category',
    'price',
    'discountPrice',
    'stock',
    'attributes',
    'weight',
    'dimensions',
  ];

  const nextPrice = req.body.price !== undefined ? req.body.price : product.price;
  const nextDiscount = req.body.discountPrice !== undefined ? normalizeDiscount(req.body.discountPrice) : product.discountPrice;
  const pricingError = validatePricing({ price: nextPrice, discountPrice: nextDiscount, stock: req.body.stock });
  if (pricingError) {
    return res.status(400).json({ message: pricingError });
  }

  editableFields.forEach((field) => {
    if (req.body[field] === undefined) return;
    const isJsonField = field === 'attributes' || field === 'dimensions';
    if (field === 'discountPrice') {
      product.discountPrice = normalizeDiscount(req.body.discountPrice) ?? undefined;
      return;
    }
    product[field] = isJsonField ? parseIfJson(req.body[field]) : req.body[field];
  });
  const contentChanged = REVIEW_FIELDS.some((field) => product.isModified(field)) || !!req.files?.length;

  if (req.user.role === 'admin' && req.body.isFeatured !== undefined) {
    product.isFeatured = req.body.isFeatured;
  }

  if (req.user.role === 'admin' && req.body.rejectionReason !== undefined) {
    product.rejectionReason = req.body.rejectionReason || undefined;
  }

  if (req.files?.length) {
    product.images = req.files.map((file) => ({ url: file.path, publicId: file.filename }));
  }

  // Content edits go back to review; a rejected listing being fixed goes
  // back to review too. Pure price/stock/weight edits keep it live.
  if (req.user.role === 'seller' && (contentChanged || product.status === 'rejected')) {
    product.status = 'pending_review';
    product.rejectionReason = undefined;
  }

  await product.save();
  res.json({ product });
});

// DELETE /api/products/:id
const deleteProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) {
    return res.status(404).json({ message: 'Product not found' });
  }

  if (req.user.role === 'seller') {
    const seller = await Seller.findOne({ user: req.user._id });
    if (!seller || String(product.seller) !== String(seller._id)) {
      return res.status(403).json({ message: 'You do not own this product' });
    }
  }

  // Orders keep a reference to the product (order pages, returns, reviews),
  // so a product that has ever been ordered is hidden instead of deleted.
  const hasOrders = await Order.exists({ 'items.product': product._id });
  if (hasOrders) {
    product.status = 'inactive';
    await product.save();
    return res.json({ message: 'This product has orders, so it was hidden from the store instead of deleted', product });
  }

  await product.deleteOne();
  res.json({ message: 'Product deleted' });
});

// PATCH /api/products/:id/approve
const approveProduct = asyncHandler(async (req, res) => {
  const product = await Product.findByIdAndUpdate(
    req.params.id,
    { status: 'active', rejectionReason: undefined },
    { returnDocument: 'after' }
  );

  if (!product) {
    return res.status(404).json({ message: 'Product not found' });
  }

  res.json({ product });
});

// PATCH /api/products/:id/reject
const rejectProduct = asyncHandler(async (req, res) => {
  const { reason } = req.body;

  if (!reason) {
    return res.status(400).json({ message: 'A rejection reason is required' });
  }

  const product = await Product.findByIdAndUpdate(
    req.params.id,
    { status: 'rejected', rejectionReason: reason },
    { returnDocument: 'after' }
  );

  if (!product) {
    return res.status(404).json({ message: 'Product not found' });
  }

  res.json({ product });
});

// PATCH /api/products/:id/deactivate (seller or admin: temporarily hide an active listing)
const deactivateProduct = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const product = await Product.findById(req.params.id);
  if (!product) {
    return res.status(404).json({ message: 'Product not found' });
  }

  if (req.user.role === 'seller') {
    const seller = await Seller.findOne({ user: req.user._id });
    if (!seller || String(product.seller) !== String(seller._id)) {
      return res.status(403).json({ message: 'You do not own this product' });
    }
  }

  if (product.status !== 'active') {
    return res.status(400).json({ message: 'Only active products can be deactivated' });
  }

  if (req.user.role === 'admin' && !reason) {
    return res.status(400).json({ message: 'A deactivation reason is required' });
  }

  product.status = 'inactive';
  if (req.user.role === 'admin') {
    product.rejectionReason = reason;
  }
  await product.save();
  res.json({ product });
});

// PATCH /api/products/:id/reactivate (seller or admin: bring a hidden listing back, no re-review needed)
const reactivateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) {
    return res.status(404).json({ message: 'Product not found' });
  }

  if (req.user.role === 'seller') {
    const seller = await Seller.findOne({ user: req.user._id });
    if (!seller || String(product.seller) !== String(seller._id)) {
      return res.status(403).json({ message: 'You do not own this product' });
    }
  }

  if (product.status !== 'inactive') {
    return res.status(400).json({ message: 'Only inactive products can be reactivated' });
  }

  product.status = 'active';
  product.rejectionReason = undefined;
  await product.save();
  res.json({ product });
});

module.exports = {
  createProduct,
  getProducts,
  getProductById,
  updateProduct,
  deleteProduct,
  approveProduct,
  rejectProduct,
  deactivateProduct,
  reactivateProduct,
};
