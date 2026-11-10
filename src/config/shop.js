// Storefront business rules shared by checkout, order creation and the
// public /api/config endpoint, so the frontend never hardcodes a number the
// backend then disagrees with (the cart used to promise "Free delivery" on a
// Rs 50 order that checkout then charged shipping on).
const FLAT_SHIPPING_FEE = 49;
const FREE_SHIPPING_THRESHOLD = 999;
const RETURN_WINDOW_DAYS = 7;
const MAX_QTY_PER_ITEM = 20;
// An online order whose payment never completes is cancelled (and its stock
// released) after this long, instead of holding inventory for a full day.
const PAYMENT_WINDOW_MINUTES = Number(process.env.PAYMENT_WINDOW_MINUTES) || 60;

module.exports = { FLAT_SHIPPING_FEE, FREE_SHIPPING_THRESHOLD, RETURN_WINDOW_DAYS, MAX_QTY_PER_ITEM, PAYMENT_WINDOW_MINUTES };
