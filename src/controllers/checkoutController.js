const Product = require('../models/Product');
const asyncHandler = require('../utils/asyncHandler');
const { computeShippingForCart, FLAT_SHIPPING_FEE } = require('../services/shippingRate.service');

const PINCODE_PATTERN = /^\d{6}$/;

// Groups cart items by seller and looks up each product once — shared shape
// used by both this endpoint and orderController.createOrder via
// shippingRate.service.js's computeShippingForCart.
async function groupCartBySeller(cartItems) {
  const productIds = cartItems.map((i) => i.productId);
  const products = await Product.find({ _id: { $in: productIds } }).select('name seller weight dimensions price discountPrice');
  const productById = new Map(products.map((p) => [String(p._id), p]));

  const missingProductIds = [];
  const groupedBySeller = new Map();

  cartItems.forEach(({ productId, quantity }) => {
    const product = productById.get(String(productId));
    if (!product) {
      missingProductIds.push(productId);
      return;
    }

    const sellerId = String(product.seller);
    const qty = Number(quantity) || 1;
    const unitPrice = product.discountPrice ?? product.price;

    if (!groupedBySeller.has(sellerId)) {
      groupedBySeller.set(sellerId, { items: [], productById: new Map(), subtotal: 0 });
    }
    const group = groupedBySeller.get(sellerId);
    group.items.push({ product: product._id, quantity: qty, name: product.name });
    group.productById.set(String(product._id), product);
    group.subtotal += unitPrice * qty;
  });

  const itemsTotal = [...groupedBySeller.values()].reduce((sum, g) => sum + g.subtotal, 0);

  return { groupedBySeller, missingProductIds, itemsTotal };
}

// POST /api/checkout/shipping-estimate
// Body: { pincode, cartItems: [{ productId, quantity }], paymentMethod? }
// Blocks (422) with the specific product names when any seller in the cart
// can't ship to this pincode — this is the checkout-time gate PART 2.9 asks
// for; order creation itself stays lenient (see orderController.js) since a
// determined API client bypassing this endpoint is still caught by the
// fulfillment chain's own unserviceable-pincode handling (PART 2.6 step 2).
const getShippingEstimate = asyncHandler(async (req, res) => {
  const { pincode, cartItems, paymentMethod = 'online' } = req.body;

  if (!pincode || !PINCODE_PATTERN.test(pincode)) {
    return res.status(400).json({ message: 'A valid 6-digit delivery pincode is required' });
  }
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return res.status(400).json({ message: 'cartItems is required' });
  }

  const { groupedBySeller, missingProductIds, itemsTotal } = await groupCartBySeller(cartItems);

  if (missingProductIds.length > 0) {
    return res.status(400).json({ message: 'Some items in your cart are no longer available', missingProductIds });
  }

  const result = await computeShippingForCart({ groupedBySeller, deliveryPincode: pincode, paymentMethod, itemsTotal });

  if (!result.serviceable) {
    return res.status(422).json({
      message: `These items can't currently be delivered to ${pincode}: ${result.unserviceableProductNames.join(', ')}`,
      serviceable: false,
      unserviceableProductNames: result.unserviceableProductNames,
      perSeller: result.perSeller,
    });
  }

  res.json({
    serviceable: true,
    shippingFee: result.shippingFee,
    estimatedDeliveryDays: result.estimatedDeliveryDays,
    perSeller: result.perSeller,
    usedFallback: result.usedFallback,
  });
});

module.exports = { getShippingEstimate, groupCartBySeller, FLAT_SHIPPING_FEE };
