// Thin client around Shiprocket's External API (https://apiv2.shiprocket.in/v1/external).
// No SDK exists for this, so every call goes through shiprocketFetch(), which
// handles auth-token attachment/refresh. Credentials never appear in code —
// only via process.env.SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD.

const BASE_URL = 'https://apiv2.shiprocket.in/v1/external';

// Shiprocket tokens are valid ~10 days; refresh a day early so a
// near-expiry token is never handed to a caller mid-request.
const TOKEN_TTL_MS = 9 * 24 * 60 * 60 * 1000;

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function login() {
  const email = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;
  if (!email || !password) {
    throw new Error('SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD are not set');
  }

  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    throw new Error(`Shiprocket login failed (${res.status}): ${JSON.stringify(data)}`);
  }

  cachedToken = data.token;
  cachedTokenExpiresAt = Date.now() + TOKEN_TTL_MS;
  return cachedToken;
}

// Logs in only when there's no cached token or it's past its refresh point;
// otherwise reuses the in-memory one. Caching is per-process (no Redis/DB
// involved) — acceptable here since a single Node process is what's
// actually holding the Shiprocket session open.
async function getToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) {
    return cachedToken;
  }
  return login();
}

async function rawRequest(path, { method = 'GET', body, token }) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

// Wraps every authenticated call: attaches the cached token, and if
// Shiprocket rejects it as expired/invalid (401) mid-lifetime — which can
// happen if the account logs in elsewhere and rotates the token server-side
// before our local TTL guess expires — forces one fresh login and retries
// exactly once rather than failing the caller outright.
async function shiprocketFetch(path, options = {}) {
  const token = await getToken();
  let { res, data } = await rawRequest(path, { ...options, token });

  if (res.status === 401) {
    cachedToken = null;
    const freshToken = await getToken();
    ({ res, data } = await rawRequest(path, { ...options, token: freshToken }));
  }

  if (!res.ok) {
    throw new Error(`Shiprocket ${options.method || 'GET'} ${path} failed (${res.status}): ${JSON.stringify(data)}`);
  }

  return data;
}

// Registers a seller's pickup address as a named pickup location under our
// Shiprocket account (required before /orders/create/adhoc can reference it
// — Shiprocket's adhoc order API takes a pickup_location *nickname*, not a
// raw address). Idempotent: reuses the seller's already-registered nickname
// if one exists, and tolerates Shiprocket's "already exists" response for a
// nickname collision instead of treating it as a hard failure.
// sellerEmail is passed in rather than read off `seller` because Seller has
// no email field of its own — it lives on the linked User document, so the
// caller (orderFulfillment.service.js) resolves it via a populate/lookup.
async function ensurePickupLocation(seller, sellerEmail) {
  if (seller.shiprocketPickupLocationName) {
    return seller.shiprocketPickupLocationName;
  }

  const nickname = `seller-${seller._id}`.slice(0, 36);
  const { pickupAddress } = seller;

  try {
    await shiprocketFetch('/settings/company/addpickup', {
      method: 'POST',
      body: {
        pickup_location: nickname,
        name: seller.businessName,
        email: sellerEmail,
        phone: seller.contactPhone,
        address: pickupAddress.line1,
        address_2: pickupAddress.line2 || '',
        city: pickupAddress.city,
        state: pickupAddress.state,
        country: pickupAddress.country || 'India',
        pin_code: pickupAddress.pincode,
      },
    });
  } catch (err) {
    // Shiprocket returns a 422-ish "pickup location already exists" if the
    // nickname was already registered (e.g. a retried request) — that's a
    // success for our purposes, not a failure.
    if (!/already exists/i.test(err.message)) {
      throw err;
    }
  }

  return nickname;
}

// order: { orderNumber, orderDate, paymentMethod: 'online' | 'COD', subTotal,
//   customer: { name, phone, email }, shippingAddress: {...addressSnapshotSchema fields},
//   pickupLocationName, items: [{ name, sku, quantity, price }],
//   dimensions?: { length, breadth, height, weight } }
//
// One call here == one Shiprocket order. Because pickup location is a
// per-seller concept, a single BohraMart order that spans multiple sellers
// must call this once per seller — see orderFulfillment.service.js, which
// does that grouping before calling in here.
async function createShipmentOrder(order) {
  const [firstName, ...rest] = order.customer.name.trim().split(' ');
  const dims = order.dimensions || { length: 20, breadth: 15, height: 10, weight: 0.5 };

  const payload = {
    order_id: order.orderNumber,
    order_date: order.orderDate,
    pickup_location: order.pickupLocationName,
    billing_customer_name: firstName,
    billing_last_name: rest.join(' ') || firstName,
    billing_address: order.shippingAddress.line1,
    billing_address_2: order.shippingAddress.line2 || '',
    billing_city: order.shippingAddress.city,
    billing_pincode: order.shippingAddress.pincode,
    billing_state: order.shippingAddress.state,
    billing_country: order.shippingAddress.country || 'India',
    billing_email: order.customer.email,
    billing_phone: order.customer.phone,
    shipping_is_billing: true,
    order_items: order.items.map((item) => ({
      name: item.name,
      sku: item.sku,
      units: item.quantity,
      selling_price: item.price,
    })),
    payment_method: order.paymentMethod === 'COD' ? 'COD' : 'Prepaid',
    sub_total: order.subTotal,
    length: dims.length,
    breadth: dims.breadth,
    height: dims.height,
    weight: dims.weight,
  };

  return shiprocketFetch('/orders/create/adhoc', { method: 'POST', body: payload });
}

async function cancelShipmentOrder(shiprocketOrderId) {
  return shiprocketFetch('/orders/cancel', { method: 'POST', body: { ids: [shiprocketOrderId] } });
}

async function trackShipment(shipmentId) {
  return shiprocketFetch(`/courier/track/shipment/${shipmentId}`, { method: 'GET' });
}

// items: [{ sku, name, quantity, price }] — the items from the order being returned.
// sellerAddress/sellerEmail/sellerPhone/sellerName describe the *destination*
// warehouse the return ships back to.
//
// NOTE: Shiprocket's /orders/create/return field names below are transcribed
// from their public API reference, not exercised against a live sandbox in
// this change — verify field names against current Shiprocket docs with a
// real test call (see backend/scripts/test-shiprocket.js) before relying on
// this in production.
async function requestReturn({
  orderNumber,
  orderDate,
  customer,
  shippingAddress,
  sellerName,
  sellerAddress,
  sellerEmail,
  sellerPhone,
  items,
  subTotal,
}) {
  const [firstName, ...rest] = customer.name.trim().split(' ');

  // A return is the mirror image of a forward shipment: Shiprocket picks up
  // from the *customer* ("pickup_*") and delivers back to the *seller's*
  // warehouse ("shipping_*"), so pickup/delivery swap relative to createShipmentOrder.
  const payload = {
    order_id: `${orderNumber}-RET`,
    order_date: orderDate,
    pickup_customer_name: firstName,
    pickup_last_name: rest.join(' ') || firstName,
    pickup_address: shippingAddress.line1,
    pickup_address_2: shippingAddress.line2 || '',
    pickup_city: shippingAddress.city,
    pickup_state: shippingAddress.state,
    pickup_country: shippingAddress.country || 'India',
    pickup_pincode: shippingAddress.pincode,
    pickup_email: customer.email,
    pickup_phone: customer.phone,
    shipping_customer_name: sellerName,
    shipping_address: sellerAddress.line1,
    shipping_address_2: sellerAddress.line2 || '',
    shipping_city: sellerAddress.city,
    shipping_state: sellerAddress.state,
    shipping_country: sellerAddress.country || 'India',
    shipping_pincode: sellerAddress.pincode,
    shipping_email: sellerEmail,
    shipping_phone: sellerPhone,
    order_items: items.map((item) => ({
      name: item.name,
      sku: item.sku,
      units: item.quantity,
      selling_price: item.price,
      qc_enable: false,
    })),
    payment_method: 'Prepaid',
    sub_total: subTotal,
    length: 20,
    breadth: 15,
    height: 10,
    weight: 0.5,
  };

  return shiprocketFetch('/orders/create/return', { method: 'POST', body: payload });
}

module.exports = {
  getToken,
  ensurePickupLocation,
  createShipmentOrder,
  cancelShipmentOrder,
  trackShipment,
  requestReturn,
};
