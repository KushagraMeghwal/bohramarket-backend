const User = require('../models/User');
const Seller = require('../models/Seller');
const shiprocketService = require('./shiprocket.service');

const toShiprocketDate = (date) => (date || new Date()).toISOString().slice(0, 19).replace('T', ' ');

// Called once an order is confirmed for fulfillment: immediately for COD
// orders (createOrder), or once payment is captured for online orders
// (verifyPayment / the Razorpay payment.captured webhook — both call this,
// so the idempotency check below is what stops it from double-booking).
//
// Fire-and-forget from every caller: a Shiprocket outage should never fail
// order placement or payment confirmation, so this always resolves/logs
// rather than throwing back into an HTTP response cycle.
//
// A single BohraMart order can span multiple sellers, and Shiprocket has no
// concept of a multi-warehouse order — each seller's pickup address is a
// separate Shiprocket order. So this creates one Shiprocket shipment per
// seller represented in order.items, and writes the result onto each of
// that seller's items' existing `shipment` sub-document (not a new
// order-level field — see the summary in the PR/chat for why).
async function createShipmentForOrder(order) {
  // Deliberately loud and unmissable — this is the one line that confirms
  // "yes, this order is actually being handed to Shiprocket", useful for
  // eyeballing Railway logs after a test purchase without digging.
  console.log(`\n📦 [shiprocket] Order ${order.orderNumber} confirmed — sending to Shiprocket for shipment...`);

  try {
    const sellerIds = [...new Set(order.items.map((item) => String(item.seller)))];
    const sellers = await Seller.find({ _id: { $in: sellerIds } });
    const sellerById = new Map(sellers.map((s) => [String(s._id), s]));

    const [customerUser, sellerUsers] = await Promise.all([
      User.findById(order.customer).select('email'),
      User.find({ _id: { $in: sellers.map((s) => s.user) } }).select('email'),
    ]);
    const sellerEmailByUserId = new Map(sellerUsers.map((u) => [String(u._id), u.email]));

    let changed = false;

    for (const sellerId of sellerIds) {
      const seller = sellerById.get(sellerId);
      if (!seller) {
        console.warn(`[shiprocket] order ${order.orderNumber}: seller ${sellerId} not found, skipping`);
        continue;
      }

      const groupItems = order.items.filter((item) => String(item.seller) === sellerId);

      // Idempotency: this function can legitimately be called twice for the
      // same order (e.g. the frontend's post-payment verify call and the
      // Razorpay webhook both fire for the same online order). If this
      // seller's items already carry a Shiprocket order id, skip — don't
      // create a duplicate shipment.
      if (groupItems.every((item) => item.shipment?.shiprocketOrderId)) {
        console.log(`[shiprocket] order ${order.orderNumber}: seller ${sellerId} already has a shipment, skipping (idempotent)`);
        continue;
      }

      const sellerEmail = sellerEmailByUserId.get(String(seller.user)) || 'orders@bohramart.example';
      const pickupLocationName = await shiprocketService.ensurePickupLocation(seller, sellerEmail);
      if (!seller.shiprocketPickupLocationName) {
        seller.shiprocketPickupLocationName = pickupLocationName;
        await seller.save();
      }

      const groupSubTotal = groupItems.reduce((sum, item) => sum + item.subtotal, 0);

      const response = await shiprocketService.createShipmentOrder({
        // Shiprocket order_id must be unique per Shiprocket order; a
        // multi-seller BohraMart order maps to multiple Shiprocket orders,
        // so each seller's slice gets a distinct suffix.
        orderNumber: `${order.orderNumber}-${sellerId.slice(-6)}`,
        orderDate: toShiprocketDate(order.createdAt),
        paymentMethod: order.paymentMethod,
        subTotal: groupSubTotal,
        customer: {
          name: order.shippingAddress.fullName,
          phone: order.shippingAddress.phone,
          email: customerUser?.email || 'orders@bohramart.example',
        },
        shippingAddress: order.shippingAddress,
        pickupLocationName,
        // Order items don't snapshot a product SKU, so the product's
        // ObjectId doubles as a stable, unique SKU value for Shiprocket.
        items: groupItems.map((item) => ({
          name: item.name,
          sku: String(item.product),
          quantity: item.quantity,
          price: item.price,
        })),
      });

      groupItems.forEach((item) => {
        item.shipment = item.shipment || {};
        item.shipment.shiprocketOrderId = response.order_id != null ? String(response.order_id) : undefined;
        item.shipment.shiprocketShipmentId = response.shipment_id != null ? String(response.shipment_id) : undefined;
      });
      changed = true;

      console.log(
        `✅ [shiprocket] order ${order.orderNumber}: shipment created for seller ${sellerId} — Shiprocket order_id=${response.order_id}, shipment_id=${response.shipment_id}`
      );
    }

    if (changed) {
      await order.save();
      console.log(`📦 [shiprocket] Order ${order.orderNumber}: all shipment(s) created and saved.\n`);
    } else {
      console.log(`[shiprocket] Order ${order.orderNumber}: nothing to do (already shipped or no valid sellers).\n`);
    }
  } catch (err) {
    console.error(`❌ [shiprocket] FAILED to create shipment for order ${order.orderNumber}:`, err.message || err);
    console.error(
      '   This does not affect the order itself (it stays confirmed) — Shiprocket credentials/config may need checking.\n'
    );
  }
}

module.exports = { createShipmentForOrder };
