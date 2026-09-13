// Dimension computation used by fulfillment.service.js's create_order step.
// This file used to also own createShipmentForOrder(), an eager
// "call Shiprocket immediately on order placement" function — that's been
// replaced by the job-queued, seller-accept-gated chain in
// fulfillment.service.js (PART 2.6), so it's been removed rather than left
// as dead code (nothing calls it anymore — verified via repo-wide search
// before deleting).

// Used per-item, and per-quantity-unit, whenever a product is missing
// weight/dimensions data.
const FALLBACK_ITEM_DIMENSIONS = { length: 20, breadth: 15, height: 10, weight: 0.5 };

// Computes one seller-group's combined package from real product data.
// weight: sum of (product.weight * quantity) across every item — this part
// is exact. length/breadth: the largest single item's footprint, since
// stacking generally doesn't grow footprint. height: sum of every item's
// height * quantity — a simple stacked-boxes approximation, not true bin
// packing; explicitly an approximation, not an exact fit.
// Shiprocket's field is "breadth"; the Product schema's is "width" — same
// measurement, mapped here.
function computeShipmentDimensions(groupItems, productById) {
  let totalWeight = 0;
  let maxLength = 0;
  let maxBreadth = 0;
  let totalHeight = 0;

  for (const item of groupItems) {
    const product = productById.get(String(item.product));
    const hasWeight = product?.weight != null;
    const hasDimensions =
      product?.dimensions?.length != null && product?.dimensions?.width != null && product?.dimensions?.height != null;

    if (!product || !hasWeight || !hasDimensions) {
      console.warn(
        `[shiprocket] product "${product?.name ?? item.name}" (${item.product}) is missing weight/dimensions in the catalog — using fallback ${JSON.stringify(FALLBACK_ITEM_DIMENSIONS)} per unit for ${item.quantity}x in this shipment. Fill in the product's weight/dimensions to get an accurate rate.`
      );
      totalWeight += FALLBACK_ITEM_DIMENSIONS.weight * item.quantity;
      maxLength = Math.max(maxLength, FALLBACK_ITEM_DIMENSIONS.length);
      maxBreadth = Math.max(maxBreadth, FALLBACK_ITEM_DIMENSIONS.breadth);
      totalHeight += FALLBACK_ITEM_DIMENSIONS.height * item.quantity;
      continue;
    }

    totalWeight += product.weight * item.quantity;
    maxLength = Math.max(maxLength, product.dimensions.length);
    maxBreadth = Math.max(maxBreadth, product.dimensions.width);
    totalHeight += product.dimensions.height * item.quantity;
  }

  return {
    weight: Math.round(totalWeight * 1000) / 1000,
    length: maxLength,
    breadth: maxBreadth,
    height: totalHeight,
  };
}

module.exports = { computeShipmentDimensions };
