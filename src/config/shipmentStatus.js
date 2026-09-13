// PART 4: single source of truth mapping Shiprocket's shipment status
// vocabulary onto this app's own enums (Order.js shipmentSchema.shipmentStatus
// and orderItemSchema.sellerOrderStatus). Every place that needs to
// interpret a Shiprocket status goes through mapShiprocketStatus() — no
// status-string matching should live anywhere else (this replaces the
// substring checks that used to live inline in webhookController.js).
//
// CONFIDENCE NOTE (2026-08-31, per PART 5 rule 8): Shiprocket's docs
// describe a numeric `current_status_id` on some tracking payloads, but I do
// not have a verified, current numeric-code table to hardcode — different
// doc/community sources disagree and I won't invent one. NUMERIC_STATUS_MAP
// below is intentionally empty; every status is resolved via TEXT_STATUS_RULES
// instead (matching Shiprocket's human-readable current_status/shipment_status
// text, which is what the original handler already normalized against). If a
// real payload's numeric id is ever captured, add it to NUMERIC_STATUS_MAP —
// don't guess a value. Every text-fallback resolution is logged so this gap
// stays visible rather than silently permanent.

const NUMERIC_STATUS_MAP = {
  // e.g. 7: { shipmentStatus: 'delivered', sellerOrderStatus: 'delivered' },
  // Populate once a real current_status_id is confirmed — see note above.
};

// Ordered most-specific-first: e.g. "RTO Delivered" contains "delivered" as
// a substring and must be caught by the RTO rule before the generic
// delivered rule, and "Out for Delivery" must be caught before the generic
// delivered rule too.
const TEXT_STATUS_RULES = [
  { test: /rto.*deliver|deliver.*rto/i, shipmentStatus: 'rto_delivered', sellerOrderStatus: 'rto_delivered' },
  { test: /rto/i, shipmentStatus: 'rto_initiated', sellerOrderStatus: 'rto_initiated' },
  { test: /out\s*for\s*delivery/i, shipmentStatus: 'in_transit', sellerOrderStatus: 'out_for_delivery' },
  { test: /deliver/i, shipmentStatus: 'delivered', sellerOrderStatus: 'delivered' },
  { test: /transit|shipped|dispatch/i, shipmentStatus: 'in_transit', sellerOrderStatus: 'in_transit' },
  // \w*\s* between "pick" and "up" — matches "Pickup", "Pick Up", AND
  // Shiprocket's actual "Picked Up" text (found via live testing: the
  // original `pick.?up` only allowed 0-1 characters in between, so it
  // never matched "Picked Up"'s "ed " gap and silently failed to
  // transition anything).
  { test: /pick\w*\s*up/i, shipmentStatus: 'not_shipped', sellerOrderStatus: 'picked_up' },
  { test: /cancel/i, shipmentStatus: 'not_shipped', sellerOrderStatus: 'cancelled' },
];

// { statusId?, statusText? } -> { shipmentStatus, sellerOrderStatus, matchedVia, rawStatus } | null
function mapShiprocketStatus({ statusId, statusText } = {}) {
  if (statusId != null && NUMERIC_STATUS_MAP[statusId]) {
    return { ...NUMERIC_STATUS_MAP[statusId], matchedVia: 'numeric_code', rawStatus: statusId };
  }

  if (statusId != null) {
    console.warn(
      `[shipmentStatus] no numeric mapping for current_status_id=${statusId} — falling back to text match on "${statusText}". Add this code to NUMERIC_STATUS_MAP once verified against real Shiprocket docs/payload.`
    );
  }

  if (!statusText) return null;
  const text = String(statusText);

  for (const rule of TEXT_STATUS_RULES) {
    if (rule.test.test(text)) {
      return { shipmentStatus: rule.shipmentStatus, sellerOrderStatus: rule.sellerOrderStatus, matchedVia: 'text_fallback', rawStatus: text };
    }
  }

  console.warn(`[shipmentStatus] no rule matched status text "${text}" — status left unchanged`);
  return null;
}

// Derives a parent-order-level fulfillment picture purely from each item's
// sellerOrderStatus — one pure function (items in, descriptor out), used by
// the webhook handler to decide notification milestones and available for
// admin/seller summary views, instead of scattered ifs at each call site.
const TERMINAL_SELLER_STATUSES = ['delivered', 'cancelled', 'rejected', 'rto_delivered', 'return_delivered'];
const SHIPPED_SELLER_STATUSES = ['picked_up', 'in_transit', 'out_for_delivery', 'delivered'];

function summarizeFulfillment(items) {
  const statuses = (items || []).map((item) => item.sellerOrderStatus).filter(Boolean);

  if (statuses.length === 0) {
    return { overall: 'unknown', allDelivered: false, allCancelled: false, anyShipped: false, anyOutForDelivery: false, anyRto: false };
  }

  const allDelivered = statuses.every((s) => s === 'delivered');
  const allCancelled = statuses.every((s) => s === 'cancelled' || s === 'rejected');
  const allTerminal = statuses.every((s) => TERMINAL_SELLER_STATUSES.includes(s));
  const anyDelivered = statuses.some((s) => s === 'delivered');
  const anyShipped = statuses.some((s) => SHIPPED_SELLER_STATUSES.includes(s));
  const anyOutForDelivery = statuses.some((s) => s === 'out_for_delivery');
  const anyRto = statuses.some((s) => s === 'rto_initiated' || s === 'rto_delivered');
  const anyAwaitingSeller = statuses.some((s) => s === 'awaiting_seller');

  let overall;
  if (allDelivered) overall = 'delivered';
  else if (allCancelled) overall = 'cancelled';
  else if (allTerminal && anyDelivered) overall = 'partially_delivered';
  else if (anyShipped && anyAwaitingSeller) overall = 'partially_shipped';
  else if (anyShipped) overall = 'shipped';
  else if (anyAwaitingSeller) overall = 'awaiting_seller';
  else overall = 'confirmed';

  return { overall, allDelivered, allCancelled, anyShipped, anyOutForDelivery, anyRto };
}

module.exports = { mapShiprocketStatus, summarizeFulfillment, TEXT_STATUS_RULES, NUMERIC_STATUS_MAP };
