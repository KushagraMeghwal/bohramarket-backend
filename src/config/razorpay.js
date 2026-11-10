const Razorpay = require('razorpay');

// Created on first use rather than at import: the SDK throws synchronously
// when key_id is missing, which used to crash the whole server on boot in
// any environment without Razorpay keys. Callers check
// env.isRazorpayConfigured() before offering online payment.
let client = null;
function getClient() {
  if (!client) {
    client = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return client;
}

module.exports = {
  get orders() {
    return getClient().orders;
  },
  get payments() {
    return getClient().payments;
  },
};
