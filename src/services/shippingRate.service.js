// Shared by the checkout shipping-estimate endpoint (checkoutController.js)
// and createOrder's server-side shipping fee (orderController.js) — one
// computation, not two, so "what the customer was quoted" and "what they're
// actually charged" can't silently diverge into two different code paths.
//
// Tradeoff worth being explicit about (PART 2.9): calling this from
// createOrder means order placement now makes a live Shiprocket call per
// seller in the cart, which adds real latency to the checkout critical path
// — something PART 2.5/2.6 deliberately removed Shiprocket from. This is the
// literal reading of "mirror the same server-side check... never trust the
// client-supplied shipping fee": it's still safe (rule 3 still holds — a
// Shiprocket outage falls back to the flat fee per-seller below rather than
// failing the order), but it is slower than the old flat-fee-only
// computation whenever Shiprocket responds slowly. Flagged rather than
// quietly working around it, since resolving it (e.g. trusting a short-lived
// server-cached estimate instead of recomputing) is a product decision, not
// something to decide unilaterally here.
const Seller = require('../models/Seller');
const shiprocketService = require('./shiprocket.service');
const { computeShipmentDimensions } = require('./orderFulfillment.service');
const { selectCourier } = require('./courierSelection.service');

const { FLAT_SHIPPING_FEE, FREE_SHIPPING_THRESHOLD } = require('../config/shop');

// groupedBySeller: Map<sellerId, { items: [{product, quantity, name}], productById: Map, subtotal: number }>
// Returns { serviceable, shippingFee, estimatedDeliveryDays, perSeller, unserviceableProductNames, usedFallback }
async function computeShippingForCart({ groupedBySeller, deliveryPincode, paymentMethod, itemsTotal }) {
  const sellers = await Seller.find({ _id: { $in: [...groupedBySeller.keys()] } });
  const sellerById = new Map(sellers.map((s) => [String(s._id), s]));

  const perSeller = [];
  const unserviceableProductNames = [];
  let totalRate = 0;
  let maxDays = 0;
  let usedFallback = false;

  for (const [sellerId, group] of groupedBySeller) {
    const seller = sellerById.get(sellerId);
    if (!seller) {
      group.items.forEach((i) => unserviceableProductNames.push(i.name));
      perSeller.push({ sellerId, sellerName: null, serviceable: false });
      continue;
    }

    const dimensions = computeShipmentDimensions(group.items, group.productById);

    try {
      const result = await shiprocketService.checkServiceability({
        pickupPincode: seller.pickupAddress.pincode,
        deliveryPincode,
        weight: dimensions.weight,
        cod: paymentMethod === 'COD',
        declaredValue: group.subtotal,
      });

      const couriers = result?.data?.available_courier_companies || [];
      const chosen = selectCourier(couriers, { paymentMethod });

      if (!chosen) {
        group.items.forEach((i) => unserviceableProductNames.push(i.name));
        perSeller.push({ sellerId, sellerName: seller.businessName, serviceable: false });
        continue;
      }

      perSeller.push({
        sellerId,
        sellerName: seller.businessName,
        serviceable: true,
        rate: chosen.rate,
        estimatedDeliveryDays: chosen.estimatedDeliveryDays,
      });
      totalRate += chosen.rate || 0;
      if (chosen.estimatedDeliveryDays) maxDays = Math.max(maxDays, chosen.estimatedDeliveryDays);
    } catch (err) {
      // Shiprocket outage/error — never blocks checkout (PART 5 rule 3),
      // falls back to the flat fee for this seller and logs loudly so the
      // gap is visible rather than a silently-wrong quiet number.
      console.error(`[shipping-rate] serviceability check failed for seller ${sellerId}, falling back to flat fee: ${err.message || err}`);
      usedFallback = true;
      perSeller.push({ sellerId, sellerName: seller.businessName, serviceable: true, rate: FLAT_SHIPPING_FEE, fallback: true });
      totalRate += FLAT_SHIPPING_FEE;
    }
  }

  if (unserviceableProductNames.length > 0) {
    return { serviceable: false, shippingFee: null, estimatedDeliveryDays: null, perSeller, unserviceableProductNames, usedFallback };
  }

  // Promotional free-shipping-above-threshold is a pricing rule, not a
  // serviceability one — still requires every item to have passed the
  // serviceable check above; it only zeroes the *fee*, not the requirement.
  const shippingFee = itemsTotal >= FREE_SHIPPING_THRESHOLD ? 0 : Math.round(totalRate) || FLAT_SHIPPING_FEE;

  return { serviceable: true, shippingFee, estimatedDeliveryDays: maxDays || null, perSeller, unserviceableProductNames: [], usedFallback };
}

module.exports = { computeShippingForCart, FLAT_SHIPPING_FEE, FREE_SHIPPING_THRESHOLD };
