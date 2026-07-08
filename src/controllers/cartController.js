const Cart = require('../models/Cart');
const Product = require('../models/Product');
const asyncHandler = require('../utils/asyncHandler');

const CART_POPULATE = 'name price discountPrice images stock status';

const getOrCreateCart = async (userId) => {
  let cart = await Cart.findOne({ user: userId });
  if (!cart) cart = await Cart.create({ user: userId, items: [] });
  return cart;
};

// GET /api/cart
const getCart = asyncHandler(async (req, res) => {
  const cart = await getOrCreateCart(req.user._id);
  await cart.populate('items.product', CART_POPULATE);
  res.json({ cart });
});

// POST /api/cart/items
const addItem = asyncHandler(async (req, res) => {
  const { productId, quantity = 1 } = req.body;

  if (!productId || quantity < 1) {
    return res.status(400).json({ message: 'productId and a positive quantity are required' });
  }

  const product = await Product.findById(productId);
  if (!product || product.status !== 'active') {
    return res.status(404).json({ message: 'Product not available' });
  }

  const cart = await getOrCreateCart(req.user._id);
  const existing = cart.items.find((item) => String(item.product) === String(productId));

  if (existing) {
    existing.quantity += Number(quantity);
  } else {
    cart.items.push({ product: productId, quantity });
  }

  await cart.save();
  await cart.populate('items.product', CART_POPULATE);
  res.json({ cart });
});

// PUT /api/cart/items/:productId
const updateItemQuantity = asyncHandler(async (req, res) => {
  const { quantity } = req.body;

  if (!quantity || quantity < 1) {
    return res.status(400).json({ message: 'A positive quantity is required' });
  }

  const cart = await getOrCreateCart(req.user._id);
  const item = cart.items.find((i) => String(i.product) === String(req.params.productId));

  if (!item) {
    return res.status(404).json({ message: 'Item not in cart' });
  }

  item.quantity = quantity;
  await cart.save();
  await cart.populate('items.product', CART_POPULATE);
  res.json({ cart });
});

// DELETE /api/cart/items/:productId
const removeItem = asyncHandler(async (req, res) => {
  const cart = await getOrCreateCart(req.user._id);
  cart.items = cart.items.filter((i) => String(i.product) !== String(req.params.productId));
  await cart.save();
  await cart.populate('items.product', CART_POPULATE);
  res.json({ cart });
});

// DELETE /api/cart
const clearCart = asyncHandler(async (req, res) => {
  const cart = await getOrCreateCart(req.user._id);
  cart.items = [];
  await cart.save();
  res.json({ cart });
});

module.exports = { getCart, addItem, updateItemQuantity, removeItem, clearCart };
