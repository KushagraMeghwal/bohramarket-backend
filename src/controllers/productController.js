const Product = require('../models/Product');
const Seller = require('../models/Seller');
const asyncHandler = require('../utils/asyncHandler');

const slugify = (name) =>
  `${name}-${Date.now()}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

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

  const images = (req.files || []).map((file) => ({ url: file.path, publicId: file.filename }));

  const product = await Product.create({
    seller: req.seller._id,
    name,
    slug: slugify(name),
    description,
    category,
    images,
    price,
    discountPrice,
    sku,
    stock,
    variantGroupId,
    attributes,
    weight,
    dimensions,
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
  const { category, status, seller, search, variantGroupId, minPrice, maxPrice, minRating, sort, page = 1, limit = 20 } =
    req.query;

  const filter = {};

  if (req.user?.role === 'admin') {
    if (status) filter.status = status;
  } else if (req.user?.role === 'seller') {
    const ownSeller = await Seller.findOne({ user: req.user._id });
    filter.seller = ownSeller?._id;
    if (status) filter.status = status;
  } else {
    filter.status = 'active';
  }

  if (category) filter.category = category;
  if (seller) filter.seller = seller;
  if (search) filter.$text = { $search: search };
  if (variantGroupId) filter.variantGroupId = variantGroupId;

  if (minPrice || maxPrice) {
    filter.price = {};
    if (minPrice) filter.price.$gte = Number(minPrice);
    if (maxPrice) filter.price.$lte = Number(maxPrice);
  }

  if (minRating) filter.ratingAverage = { $gte: Number(minRating) };

  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;
  const sortOrder = SORT_OPTIONS[sort] || SORT_OPTIONS.newest;

  const [products, total] = await Promise.all([
    Product.find(filter)
      .populate('category', 'name slug')
      .skip(skip)
      .limit(limitNum)
      .sort(sortOrder),
    Product.countDocuments(filter),
  ]);

  res.json({ products, total, page: pageNum, limit: limitNum });
});

// GET /api/products/:id
const getProductById = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id)
    .populate('category', 'name slug')
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

  editableFields.forEach((field) => {
    if (req.body[field] !== undefined) product[field] = req.body[field];
  });

  if (req.user.role === 'admin' && req.body.isFeatured !== undefined) {
    product.isFeatured = req.body.isFeatured;
  }

  if (req.user.role === 'admin' && req.body.rejectionReason !== undefined) {
    product.rejectionReason = req.body.rejectionReason || undefined;
  }

  if (req.files?.length) {
    product.images = req.files.map((file) => ({ url: file.path, publicId: file.filename }));
  }

  if (req.user.role === 'seller') {
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
