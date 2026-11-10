const Cart = require('../models/Cart');
const Product = require('../models/Product');
const asyncHandler = require('../utils/asyncHandler');
const { MAX_QTY_PER_ITEM } = require('../config/shop');

const CART_POPULATE = 'name price discountPrice images stock status category seller';

const getOrCreateCart = async (userId) => {
  let cart = await Cart.findOne({ user: userId });
  if (!cart) cart = await Cart.create({ user: userId, items: [] });
  return cart;
};

// Whole numbers from 1 to MAX_QTY_PER_ITEM only — the cart used to accept
// 9999 (stock 47) and 1.5.
const parseQuantity = (value) => {
  const qty = Number(value);
  return Number.isInteger(qty) && qty >= 1 && qty <= MAX_QTY_PER_ITEM ? qty : null;
};

const stockError = (product, qty) =>
  product.stock < qty ? (product.stock === 0 ? 'This item is out of stock' : `Only ${product.stock} left in stock`) : null;

const respondWithCart = async (res, cart) => {
  await cart.populate({ path: 'items.product', select: CART_POPULATE, populate: [{ path: 'category', select: 'name slug type' }, { path: 'seller', select: 'businessName' }] });
  res.json({ cart });
};

// GET /api/cart
const getCart = asyncHandler(async (req, res) => {
  const cart = await getOrCreateCart(req.user._id);
  // Drop lines whose product was deleted, so the page never renders a null.
  await cart.populate('items.product', '_id');
  const before = cart.items.length;
  cart.items = cart.items.filter((item) => item.product);
  if (cart.items.length !== before) await cart.save();
  await respondWithCart(res, cart);
});

// POST /api/cart/items
const addItem = asyncHandler(async (req, res) => {
  const { productId } = req.body;
  const quantity = parseQuantity(req.body.quantity ?? 1);

  if (!productId || !quantity) {
    return res.status(400).json({ message: `productId and a quantity between 1 and ${MAX_QTY_PER_ITEM} are required` });
  }

  const product = await Product.findById(productId);
  if (!product || product.status !== 'active') {
    return res.status(404).json({ message: 'Product not available' });
  }

  const cart = await getOrCreateCart(req.user._id);
  const existing = cart.items.find((item) => String(item.product) === String(productId));
  const newQty = (existing?.quantity || 0) + quantity;

  if (newQty > MAX_QTY_PER_ITEM) {
    return res.status(400).json({ message: `You can buy at most ${MAX_QTY_PER_ITEM} of this item per order` });
  }
  const error = stockError(product, newQty);
  if (error) {
    return res.status(400).json({ message: existing ? `${error} — you already have ${existing.quantity} in your bag` : error });
  }

  if (existing) {
    existing.quantity = newQty;
  } else {
    cart.items.push({ product: productId, quantity });
  }

  await cart.save();
  await respondWithCart(res, cart);
});

// PUT /api/cart/items/:productId
const updateItemQuantity = asyncHandler(async (req, res) => {
  const quantity = parseQuantity(req.body.quantity);

  if (!quantity) {
    return res.status(400).json({ message: `Quantity must be a whole number between 1 and ${MAX_QTY_PER_ITEM}` });
  }

  const cart = await getOrCreateCart(req.user._id);
  const item = cart.items.find((i) => String(i.product) === String(req.params.productId));

  if (!item) {
    return res.status(404).json({ message: 'Item not in cart' });
  }

  const product = await Product.findById(req.params.productId);
  if (!product || product.status !== 'active') {
    return res.status(400).json({ message: 'This item is no longer available' });
  }
  const error = stockError(product, quantity);
  if (error) {
    return res.status(400).json({ message: error });
  }

  item.quantity = quantity;
  await cart.save();
  await respondWithCart(res, cart);
});

// DELETE /api/cart/items/:productId
const removeItem = asyncHandler(async (req, res) => {
  const cart = await getOrCreateCart(req.user._id);
  cart.items = cart.items.filter((i) => String(i.product) !== String(req.params.productId));
  await cart.save();
  await respondWithCart(res, cart);
});

// DELETE /api/cart
const clearCart = asyncHandler(async (req, res) => {
  const cart = await getOrCreateCart(req.user._id);
  cart.items = [];
  await cart.save();
  res.json({ cart });
});

module.exports = { getCart, addItem, updateItemQuantity, removeItem, clearCart };
