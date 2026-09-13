// Picks a courier from a Shiprocket serviceability response. Field names on
// each courier entry (rate, cod, etd, rating, courier_company_id,
// courier_name) are transcribed from Shiprocket's public docs, same
// confidence caveat as shiprocket.service.js's new methods — not verified
// against a live response in this change.

// Priority order is swappable via SHIPROCKET_COURIER_STRATEGY, not a numeric
// weight — 'cheapest' (default) ranks by rate then days then rating;
// 'fastest' swaps rate and days per PART 3's spec.
function parseEtdDays(etd) {
  // Docs describe `etd` inconsistently (a "N-M days" string in some places,
  // a delivery date string in others) — this only confidently handles the
  // first digit-bearing form. Anything else returns null so callers treat
  // it as "unknown" rather than a wrong number.
  if (etd == null) return null;
  const match = String(etd).match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function isCourierServiceable(courier, { requireCod }) {
  // Field name for COD support and for "blocked/unavailable" isn't fully
  // certain from docs alone — checked defensively across the variants seen
  // referenced (cod/is_cod, blocked/is_active), never assuming a field that
  // isn't present means "false" in a way that would wrongly exclude every
  // courier if Shiprocket's actual response uses a name not checked here.
  if (requireCod) {
    const supportsCod = courier.cod === 1 || courier.cod === true || courier.is_cod === 1 || courier.is_cod === true;
    if (!supportsCod) return false;
  }
  if (courier.blocked === 1 || courier.blocked === true) return false;
  if (courier.is_active === 0 || courier.is_active === false) return false;
  return true;
}

// couriers: the `available_courier_companies` array from checkServiceability.
// Returns null if none are serviceable (caller's cue to take the
// unserviceable path — PART 2.6 step 2), otherwise the chosen courier plus
// a `chosenBecause` string to store on the shipment record for debugging.
function selectCourier(couriers, { paymentMethod, strategy } = {}) {
  const resolvedStrategy = strategy || process.env.SHIPROCKET_COURIER_STRATEGY || 'cheapest';
  const requireCod = paymentMethod === 'COD';

  const eligible = (couriers || []).filter((c) => isCourierServiceable(c, { requireCod }));
  if (eligible.length === 0) return null;

  const scored = eligible.map((courier) => ({
    courier,
    rate: Number(courier.rate),
    days: parseEtdDays(courier.etd),
    rating: Number(courier.rating) || 0,
  }));

  // Missing rate/days must sort *last* within their own comparison, not
  // first (which Number.NaN or a bare comparison would otherwise do) —
  // pushed to +Infinity so a courier with unknown rate/ETA never wins over
  // one with a known, worse-but-real number.
  const rank = (entry, key) => (Number.isFinite(entry[key]) ? entry[key] : Infinity);

  const [primaryKey, secondaryKey] = resolvedStrategy === 'fastest' ? ['days', 'rate'] : ['rate', 'days'];

  scored.sort((a, b) => {
    const primaryDiff = rank(a, primaryKey) - rank(b, primaryKey);
    if (primaryDiff !== 0) return primaryDiff;
    const secondaryDiff = rank(a, secondaryKey) - rank(b, secondaryKey);
    if (secondaryDiff !== 0) return secondaryDiff;
    return b.rating - a.rating; // rating: higher wins
  });

  const winner = scored[0];
  return {
    courierId: winner.courier.courier_company_id != null ? String(winner.courier.courier_company_id) : undefined,
    courierName: winner.courier.courier_name,
    rate: Number.isFinite(winner.rate) ? winner.rate : undefined,
    estimatedDeliveryDays: winner.days ?? undefined,
    rating: winner.rating,
    chosenBecause: `strategy=${resolvedStrategy}; rate=${Number.isFinite(winner.rate) ? winner.rate : 'unknown'}; days=${winner.days ?? 'unknown'}; rating=${winner.rating}; ${eligible.length} courier(s) considered`,
  };
}

module.exports = { selectCourier, parseEtdDays };
