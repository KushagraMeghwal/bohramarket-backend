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
// What an admin should actually do about a 401/403 from Shiprocket. Login and
// order creation succeeding while AWB assignment is refused almost always
// means the Shiprocket account itself isn't cleared to ship yet.
function permissionHint(path) {
  if (path.startsWith('/courier/assign/awb') || path.startsWith('/courier/generate/pickup')) {
    return (
      'Shiprocket refused to assign a courier for this order (permission denied). This is a Shiprocket account setting, not a site error: ' +
      'make sure the Shiprocket account KYC is verified (Settings → Company → KYC), the wallet has balance, and the API user ' +
      '(Settings → API → Configure) has permission to ship orders. Then press Retry — or ship the order from the Shiprocket ' +
      'dashboard ("Ship Now") and press Retry so the site picks up the AWB.'
    );
  }
  return 'Shiprocket refused this request (permission denied). Check that the API user (Settings → API → Configure) has access to this action, then press Retry.';
}

async function shiprocketFetch(path, options = {}) {
  const token = await getToken();

  let res, data;
  try {
    ({ res, data } = await rawRequest(path, { ...options, token }));
  } catch (err) {
    // fetch() itself threw — DNS/connection/timeout, not an HTTP error
    // response. Tagged isNetworkError so shiprocketRetry.service.js can tell
    // this apart from a real 4xx/5xx without parsing the message string.
    const networkErr = new Error(`Shiprocket ${options.method || 'GET'} ${path} network error: ${err.message}`);
    networkErr.isNetworkError = true;
    throw networkErr;
  }

  if (res.status === 401) {
    cachedToken = null;
    const freshToken = await getToken();
    ({ res, data } = await rawRequest(path, { ...options, token: freshToken }));
  }

  if (!res.ok) {
    // .status is additive — existing callers that only read err.message are
    // unaffected; shiprocketRetry.service.js uses .status to decide whether
    // a failure is worth retrying (5xx) or not (4xx — retrying an identical
    // bad request just reproduces the same error).
    const httpErr = new Error(`Shiprocket ${options.method || 'GET'} ${path} failed (${res.status}): ${JSON.stringify(data)}`);
    httpErr.status = res.status;
    // The raw parsed JSON body, kept alongside the stringified .message so
    // callers that need field-level detail (see parseShiprocketError below)
    // don't have to re-parse it back out of the message string.
    httpErr.responseBody = data;
    // A permission refusal won't change by retrying — it needs someone to fix
    // the Shiprocket account. Flag it so the job queue stops immediately and
    // tells the admin what to do instead of burning its retries.
    if (res.status === 401 || res.status === 403) {
      httpErr.permanent = true;
      httpErr.adminHint = permissionHint(path);
    }
    throw httpErr;
  }

  return data;
}

// Shiprocket's validation errors come back one level double-encoded: the
// response body is JSON, but its own `message` field is itself a
// JSON-stringified object of {field: [messages]} — e.g.
// {"message":"{\"address\":[\"Address line 1 should have House no / Flat no
// / Road no.\"]}","status_code":422}. This unwraps that into a clean
// {field, message} pair (or falls back to a plain message when the body
// isn't shaped this way — a network error, a 5xx with no JSON body, etc.).
function parseShiprocketError(err) {
  const rawMessage = err?.responseBody?.message;

  if (typeof rawMessage === 'string') {
    try {
      const parsed = JSON.parse(rawMessage);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const [field] = Object.keys(parsed);
        if (field) {
          const fieldMessages = parsed[field];
          const message = Array.isArray(fieldMessages) ? fieldMessages[0] : String(fieldMessages);
          if (message) return { field, message };
        }
      }
    } catch {
      // rawMessage wasn't JSON — it's already a plain human-readable string.
      return { field: null, message: rawMessage };
    }
  }

  return { field: null, message: err?.message || 'Shiprocket rejected this request.' };
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
    // Shiprocket returns a 422 with a "pickup location already exists"
    // message if the nickname was already registered (e.g. a retried
    // request) — that's a success for our purposes, not a failure. Checked
    // narrowly (specific status code + message mentioning both "pickup
    // location" and "already exists", not a bare "already exists" substring
    // anywhere in the response) so an unrelated validation error that
    // happens to contain similar wording elsewhere in the payload isn't
    // silently swallowed as a false "success" (PART 2.10 hardening).
    const isPickupLocationConflict = err.status === 422 && /pickup\s*location/i.test(err.message) && /already\s*exists/i.test(err.message);
    if (!isPickupLocationConflict) {
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
  // No silent fallback here on purpose — every real caller (see
  // orderFulfillment.service.js computeShipmentDimensions) is expected to
  // compute real dimensions from the order's products before calling in. A
  // missing order.dimensions is a caller bug, not something to paper over
  // with a made-up box size that would silently misprice every shipment.
  if (!order.dimensions) {
    throw new Error('createShipmentOrder: order.dimensions is required (no fallback — compute it from product weight/dimensions before calling)');
  }

  const [firstName, ...rest] = order.customer.name.trim().split(' ');
  const dims = order.dimensions;

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

async function trackByAwb(awb) {
  return shiprocketFetch(`/courier/track/awb/${awb}`, { method: 'GET' });
}

// NOTE: field names for every function below (through generateManifest) are
// transcribed from Shiprocket's public API reference docs, the same way the
// original requestReturn() above was — none of them have been exercised
// against a live Shiprocket account in this change. Verify the exact
// request/response shape against a real call (or current docs) before
// depending on any field not already covered by createShipmentOrder/
// cancelShipmentOrder/trackShipment, which *have* been exercised live.

// pickupPincode/deliveryPincode: 6-digit strings. weight: kg (Number). cod:
// boolean (order.paymentMethod === 'COD'). declaredValue: order subtotal, used
// by Shiprocket for insurance/COD-limit checks — optional.
// Response shape (per docs): { data: { available_courier_companies: [
//   { courier_company_id, courier_name, rate, cod, etd (days or date string),
//     rating, ... } ], recommended_courier_company_id } }
// courierSelection.service.js (PART 3) reads available_courier_companies.
async function checkServiceability({ pickupPincode, deliveryPincode, weight, cod, declaredValue }) {
  const params = new URLSearchParams({
    pickup_postcode: String(pickupPincode),
    delivery_postcode: String(deliveryPincode),
    weight: String(weight),
    cod: cod ? '1' : '0',
  });
  if (declaredValue != null) params.set('declared_value', String(declaredValue));

  return shiprocketFetch(`/courier/serviceability/?${params.toString()}`, { method: 'GET' });
}

// Reverse pickup (return) serviceability is not a separate Shiprocket
// endpoint as far as the public docs describe — it's the same
// /courier/serviceability/ call with pickup/delivery swapped (the customer's
// address becomes the pickup point, the seller's warehouse becomes delivery).
async function checkReturnServiceability({ customerPincode, sellerPincode, weight, declaredValue }) {
  return checkServiceability({
    pickupPincode: customerPincode,
    deliveryPincode: sellerPincode,
    weight,
    cod: false, // returns are never COD
    declaredValue,
  });
}

// courierId omitted lets Shiprocket auto-assign its recommended courier;
// pass it to force a specific one (see courierSelection.service.js).
// Response shape (per docs): { response: { data: { awb_code, courier_name,
//   courier_company_id, ... } } } — read defensively by the caller since
// this hasn't been verified live.
// Reads back an order we created, to pick up an AWB that someone assigned
// from the Shiprocket dashboard ("Ship Now") instead of through the API.
// Returns { awb, courierName } or null. Response shape varies by account, so
// every field is read defensively.
async function getAssignedAwb(shiprocketOrderId) {
  const response = await shiprocketFetch(`/orders/show/${encodeURIComponent(shiprocketOrderId)}`);
  const data = response?.data || response;
  const shipment = Array.isArray(data?.shipments) ? data.shipments[0] : data?.shipments;
  const awb = data?.awb_data?.awb || shipment?.awb || shipment?.awb_code || data?.awb_code;
  if (!awb) return null;
  return { awb: String(awb), courierName: shipment?.courier || shipment?.courier_name || data?.courier_name };
}

async function assignAwb({ shipmentId, courierId }) {
  const body = { shipment_id: shipmentId };
  if (courierId != null) body.courier_id = courierId;
  return shiprocketFetch('/courier/assign/awb', { method: 'POST', body });
}

// Response shape (per docs): { pickup_status, response: { pickup_scheduled_date,
//   pickup_token_number, ... } }
async function requestPickup({ shipmentId }) {
  return shiprocketFetch('/courier/generate/pickup', { method: 'POST', body: { shipment_id: [shipmentId] } });
}

// shipmentIds: array — Shiprocket supports generating one label PDF covering
// multiple shipments, but callers here always pass a single-element array
// (one label per seller's shipment) to keep the label 1:1 with our own
// shipment record. Response shape (per docs): { label_created, label_url }.
async function generateLabel({ shipmentIds }) {
  return shiprocketFetch('/courier/generate/label', { method: 'POST', body: { shipment_id: shipmentIds } });
}

// orderIds here are Shiprocket's own numeric order ids (the `order_id` a
// createShipmentOrder response returns), NOT our orderNumber string.
// Response shape (per docs): { is_invoice_created, invoice_url }.
async function generateInvoice({ orderIds }) {
  return shiprocketFetch('/orders/print/invoice', { method: 'POST', body: { ids: orderIds } });
}

// LOWER CONFIDENCE than the functions above — the exact response shape for
// manifest generation (whether it returns a direct URL or a token you poll)
// is not clearly documented publicly. Treat generateManifest's return value
// as opaque until confirmed against a real call; do not assume a
// `manifest_url` field exists without checking the actual response first.
async function generateManifest({ shipmentIds }) {
  return shiprocketFetch('/manifests/generate', { method: 'POST', body: { shipment_id: shipmentIds } });
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
  parseShiprocketError,
  ensurePickupLocation,
  createShipmentOrder,
  cancelShipmentOrder,
  trackShipment,
  trackByAwb,
  requestReturn,
  checkServiceability,
  checkReturnServiceability,
  assignAwb,
  getAssignedAwb,
  requestPickup,
  generateLabel,
  generateInvoice,
  generateManifest,
};
