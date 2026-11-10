// The auto-fulfillment chain (PART 2.6): registers one handler per
// ShipmentJob step with shipmentJobQueue.service.js (PART 2.4). Each handler
// is `async (order, seller, job) => { nextStep: string | null }` — returns
// the next step to enqueue, or null when this seller's chain is finished
// (either successfully ready-to-ship, or deliberately ended early on an
// unserviceable pincode).
//
// Requiring this module is what actually wires the handlers in — done once,
// from index.js at boot.
const User = require('../models/User');
const Product = require('../models/Product');
const shiprocketService = require('./shiprocket.service');
const shipmentJobQueue = require('./shipmentJobQueue.service');
const { computeShipmentDimensions } = require('./orderFulfillment.service');
const { selectCourier } = require('./courierSelection.service');
const { rejectAndSettleItem } = require('./sellerItemSettlement.service');
const { registerShiprocketPickup } = require('./sellerPickupRegistration.service');
const notificationService = require('./notification.service');

const toShiprocketDate = (date) => (date || new Date()).toISOString().slice(0, 19).replace('T', ' ');

function groupItemsFor(order, seller) {
  return order.items.filter((item) => String(item.seller) === String(seller._id));
}

function pushHistory(item, status, source) {
  item.statusHistory = item.statusHistory || [];
  item.statusHistory.push({ status, source, at: new Date() });
}

// Step 1: register (or confirm) the seller's Shiprocket pickup location —
// PART 2.10 moved eager registration to seller-approval time, so by the time
// most orders reach this step it's usually already 'registered' and
// registerShiprocketPickup's own ensurePickupLocation short-circuits
// immediately (no network call). This step still exists and still runs
// every time, though: it's what catches a seller who was approved before
// PART 2.10 existed, or whose registration failed at approval and hasn't
// been retried yet.
//
// A failure here must stop the whole chain rather than continue to
// serviceability with no registered pickup address. Throwing (rather than
// swallowing) is what achieves that: the job queue (2.4) only enqueues the
// next step on success, so a permanently-failing job just never produces a
// serviceability job — the chain stops itself, no extra flag needed.
async function stepEnsurePickup(order, seller) {
  const result = await registerShiprocketPickup(seller);
  if (!result.success) {
    throw new Error(result.error);
  }
  return { nextStep: 'serviceability' };
}

// Step 2 + 3: checkServiceability, then pick a courier (courierSelection.service.js).
// Unserviceable is a deliberate end state for this seller's items, not an
// error — it settles the items (cancel + refund-flag) and ends the chain
// with nextStep: null, same as a normal completion.
async function stepServiceability(order, seller) {
  const groupItems = groupItemsFor(order, seller);
  const products = await Product.find({ _id: { $in: groupItems.map((i) => i.product) } }).select('name weight dimensions');
  const productById = new Map(products.map((p) => [String(p._id), p]));
  const dimensions = computeShipmentDimensions(groupItems, productById);

  const declaredValue = groupItems.reduce((sum, item) => sum + item.subtotal, 0);

  const result = await shiprocketService.checkServiceability({
    pickupPincode: seller.pickupAddress.pincode,
    deliveryPincode: order.shippingAddress.pincode,
    weight: dimensions.weight,
    cod: order.paymentMethod === 'COD',
    declaredValue,
  });

  const couriers = result?.data?.available_courier_companies || [];
  const chosen = selectCourier(couriers, { paymentMethod: order.paymentMethod });

  if (!chosen) {
    console.warn(
      `[fulfillment] order ${order.orderNumber}, seller ${seller._id}: no courier serviceable from ${seller.pickupAddress.pincode} to ${order.shippingAddress.pincode} — cancelling this seller's items`
    );
    for (const item of groupItems) {
      await rejectAndSettleItem(order, item, {
        reason: `No courier is serviceable from your pickup pincode (${seller.pickupAddress.pincode}) to the delivery pincode (${order.shippingAddress.pincode})`,
        source: 'system',
      });
    }
    await order.save();
    // rejectAndSettleItem already sent the customer's CANCELLED (and, if
    // applicable, REFUND_INITIATED) SMS above — just the admin-facing side
    // left to handle here.
    notificationService.notifyAdmin(
      `Order ${order.orderNumber}, seller ${seller._id} (${seller.businessName}): no courier serviceable from ${seller.pickupAddress.pincode} to ${order.shippingAddress.pincode} — item(s) cancelled`
    );
    return { nextStep: null };
  }

  groupItems.forEach((item) => {
    item.shipment = item.shipment || {};
    item.shipment.courierId = chosen.courierId;
    item.shipment.courierName = chosen.courierName;
    item.shipment.shippingRate = chosen.rate;
    item.shipment.estimatedDeliveryDays = chosen.estimatedDeliveryDays;
    item.shipment.courierSelectionReason = chosen.chosenBecause;
    item.sellerOrderStatus = 'confirmed';
    pushHistory(item, 'confirmed', 'system');
  });
  await order.save();

  return { nextStep: 'create_order' };
}

// Step 4: createShipmentOrder. Idempotent — a retried job (e.g. the queue
// retrying after order.save() failed post-response) skips straight ahead
// if a Shiprocket order id is already recorded, rather than double-booking.
async function stepCreateOrder(order, seller) {
  const groupItems = groupItemsFor(order, seller);

  if (groupItems.every((item) => item.shipment?.shiprocketOrderId)) {
    return { nextStep: 'assign_awb' };
  }

  const products = await Product.find({ _id: { $in: groupItems.map((i) => i.product) } }).select('name weight dimensions');
  const productById = new Map(products.map((p) => [String(p._id), p]));
  const dimensions = computeShipmentDimensions(groupItems, productById);

  const customerUser = await User.findById(order.customer).select('email');
  const groupSubTotal = groupItems.reduce((sum, item) => sum + item.subtotal, 0);
  const sellerIdSuffix = String(seller._id).slice(-6);

  const response = await shiprocketService.createShipmentOrder({
    orderNumber: `${order.orderNumber}-${sellerIdSuffix}`,
    orderDate: toShiprocketDate(order.createdAt),
    paymentMethod: order.paymentMethod,
    subTotal: groupSubTotal,
    customer: {
      name: order.shippingAddress.fullName,
      phone: order.shippingAddress.phone,
      email: customerUser?.email || 'orders@bohramart.example',
    },
    shippingAddress: order.shippingAddress,
    pickupLocationName: seller.shiprocketPickupLocationName,
    dimensions,
    items: groupItems.map((item) => ({
      name: item.name,
      sku: String(item.product),
      quantity: item.quantity,
      price: item.price,
    })),
  });

  groupItems.forEach((item) => {
    item.shipment.shiprocketOrderId = response.order_id != null ? String(response.order_id) : undefined;
    item.shipment.shiprocketShipmentId = response.shipment_id != null ? String(response.shipment_id) : undefined;
  });
  await order.save();

  return { nextStep: 'assign_awb' };
}

// Step 5: assignAwb. Response shape uncertain (see shiprocket.service.js) —
// read defensively, and fail loudly (throw) rather than silently accept a
// response with no awb_code, since a "successful" call with no AWB is worse
// than an obvious error: it would otherwise silently stall the chain.
async function stepAssignAwb(order, seller) {
  const groupItems = groupItemsFor(order, seller);

  if (groupItems.every((item) => item.shipment?.awbNumber)) {
    return { nextStep: 'request_pickup' };
  }

  const shipmentId = groupItems[0]?.shipment?.shiprocketShipmentId;
  if (!shipmentId) {
    throw new Error(`assign_awb: order ${order.orderNumber} seller ${seller._id} has no shiprocketShipmentId — create_order must run first`);
  }
  const courierId = groupItems[0]?.shipment?.courierId;

  // If the order was shipped by hand from the Shiprocket dashboard (e.g.
  // after API assignment was refused), adopt that AWB instead of asking for
  // a second one.
  const shiprocketOrderId = groupItems[0]?.shipment?.shiprocketOrderId;
  if (shiprocketOrderId) {
    const existing = await shiprocketService.getAssignedAwb(shiprocketOrderId).catch((err) => {
      console.warn(`[fulfillment] could not read Shiprocket order ${shiprocketOrderId} before assigning AWB: ${err.message}`);
      return null;
    });
    if (existing?.awb) {
      groupItems.forEach((item) => {
        item.shipment.awbNumber = existing.awb;
        if (existing.courierName) item.shipment.courierName = existing.courierName;
      });
      await order.save();
      console.log(`[fulfillment] order ${order.orderNumber}: adopted AWB ${existing.awb} already assigned in Shiprocket`);
      return { nextStep: 'request_pickup' };
    }
  }

  const response = await shiprocketService.assignAwb({ shipmentId, courierId });
  const data = response?.response?.data || response?.data || response;
  const awbCode = data?.awb_code;

  if (!awbCode) {
    throw new Error(`assign_awb: no awb_code in response for order ${order.orderNumber} (response shape uncertain): ${JSON.stringify(response)}`);
  }

  groupItems.forEach((item) => {
    item.shipment.awbNumber = String(awbCode);
    if (data?.courier_name) item.shipment.courierName = data.courier_name;
  });
  await order.save();

  return { nextStep: 'request_pickup' };
}

// Step 6: requestPickup.
async function stepRequestPickup(order, seller) {
  const groupItems = groupItemsFor(order, seller);
  const shipmentId = groupItems[0]?.shipment?.shiprocketShipmentId;
  if (!shipmentId) {
    throw new Error(`request_pickup: order ${order.orderNumber} seller ${seller._id} has no shiprocketShipmentId`);
  }

  const response = await shiprocketService.requestPickup({ shipmentId });
  const data = response?.response || response;
  const pickupDateRaw = data?.pickup_scheduled_date;

  if (pickupDateRaw) {
    const parsed = new Date(pickupDateRaw);
    if (!Number.isNaN(parsed.getTime())) {
      groupItems.forEach((item) => {
        item.shipment.pickupScheduledDate = parsed;
      });
      await order.save();
    }
  }

  return { nextStep: 'generate_label' };
}

// Step 7a: generateLabel. A missing label_url in an otherwise-OK response is
// logged, not thrown — an uncertain response shape shouldn't retry-loop a
// call that Shiprocket itself considered successful (see PART 5 rule 8).
async function stepGenerateLabel(order, seller) {
  const groupItems = groupItemsFor(order, seller);

  if (groupItems.every((item) => item.shipment?.labelUrl)) {
    return { nextStep: 'generate_invoice' };
  }

  const shipmentId = groupItems[0]?.shipment?.shiprocketShipmentId;
  const response = await shiprocketService.generateLabel({ shipmentIds: [shipmentId] });
  const labelUrl = response?.label_url;

  if (labelUrl) {
    groupItems.forEach((item) => {
      item.shipment.labelUrl = labelUrl;
    });
    await order.save();
  } else {
    console.warn(`[fulfillment] generate_label: no label_url in response for order ${order.orderNumber} (shape uncertain): ${JSON.stringify(response)}`);
  }

  return { nextStep: 'generate_invoice' };
}

// Step 7b: generateInvoice — also the step that finally marks this seller's
// items ready_to_ship (PART 2.6 step 8), since it's the last item in the
// documented chain.
async function stepGenerateInvoice(order, seller) {
  const groupItems = groupItemsFor(order, seller);

  if (!groupItems.every((item) => item.shipment?.invoiceUrl)) {
    const shiprocketOrderId = groupItems[0]?.shipment?.shiprocketOrderId;
    const response = await shiprocketService.generateInvoice({ orderIds: [Number(shiprocketOrderId)] });
    const invoiceUrl = response?.invoice_url;

    if (invoiceUrl) {
      groupItems.forEach((item) => {
        item.shipment.invoiceUrl = invoiceUrl;
      });
    } else {
      console.warn(
        `[fulfillment] generate_invoice: no invoice_url in response for order ${order.orderNumber} (shape uncertain): ${JSON.stringify(response)}`
      );
    }
  }

  groupItems.forEach((item) => {
    item.sellerOrderStatus = 'ready_to_ship';
    pushHistory(item, 'ready_to_ship', 'system');
  });
  await order.save();

  console.log(`[fulfillment] order ${order.orderNumber}, seller ${seller._id}: ready_to_ship (chain complete)`);

  notificationService.notifyCustomer({ order, templateKey: 'ORDER_CONFIRMED', vars: { orderNumber: order.orderNumber } });
  // Routine success — logged only; notifyAdmin now emails, and admins only
  // need to hear about things that need a human.
  console.log(`[fulfillment] order ${order.orderNumber}, seller ${seller._id} (${seller.businessName}): ready_to_ship`);

  return { nextStep: null };
}

shipmentJobQueue.registerStepHandler('ensure_pickup', stepEnsurePickup);
shipmentJobQueue.registerStepHandler('serviceability', stepServiceability);
shipmentJobQueue.registerStepHandler('create_order', stepCreateOrder);
shipmentJobQueue.registerStepHandler('assign_awb', stepAssignAwb);
shipmentJobQueue.registerStepHandler('request_pickup', stepRequestPickup);
shipmentJobQueue.registerStepHandler('generate_label', stepGenerateLabel);
shipmentJobQueue.registerStepHandler('generate_invoice', stepGenerateInvoice);

module.exports = {
  // Exported individually for independent testing (PART 5 rule 9) — each
  // step is a plain async function taking (order, seller) and can be
  // called directly with fixture data without touching the job queue.
  stepEnsurePickup,
  stepServiceability,
  stepCreateOrder,
  stepAssignAwb,
  stepRequestPickup,
  stepGenerateLabel,
  stepGenerateInvoice,
};
