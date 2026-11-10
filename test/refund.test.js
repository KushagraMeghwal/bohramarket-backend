// Refund service against a mocked Razorpay SDK — no network, no database
// (orders are in-memory Mongoose documents that are never saved).
// Run with: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy';
process.env.RAZORPAY_KEY_SECRET = 'dummy_secret';

// Stub the Razorpay client and notifications in place (the services hold
// references to these module objects, so patching them is enough).
const refundCalls = [];
let nextRefundError = null;
Object.defineProperty(require('../src/config/razorpay'), 'payments', {
  value: {
    refund: async (paymentId, body) => {
      refundCalls.push({ paymentId, body });
      if (nextRefundError) {
        const err = nextRefundError;
        nextRefundError = null;
        throw err;
      }
      return { id: `rfnd_${refundCalls.length}`, status: 'pending' };
    },
  },
});
Object.assign(require('../src/services/notification.service'), {
  notifyCustomer: () => {},
  notifyAdmin: () => {},
  notifySeller: () => {},
  sendSms: () => {},
});

const mongoose = require('mongoose');
const Order = require('../src/models/Order');
const { refundItems, applyRefundWebhook, retryRefund } = require('../src/services/refund.service');

function paidOrder({ shippingFee = 49 } = {}) {
  const seller = new mongoose.Types.ObjectId();
  const item = (price, qty = 1) => ({
    product: new mongoose.Types.ObjectId(),
    seller,
    name: `Item ${price}`,
    price,
    quantity: qty,
    subtotal: price * qty,
    itemStatus: 'placed',
  });
  return new Order({
    orderNumber: 'BMTEST1',
    customer: new mongoose.Types.ObjectId(),
    items: [item(500), item(300)],
    shippingAddress: { fullName: 'A', phone: '9000000000', line1: 'x', city: 'y', state: 'z', pincode: '452001' },
    itemsTotal: 800,
    shippingFee,
    totalAmount: 800 + shippingFee,
    paymentMethod: 'online',
    paymentStatus: 'paid',
    razorpay: { orderId: 'order_1', paymentId: 'pay_1' },
  });
}

test('refunds one cancelled item for exactly its subtotal, in paise', async () => {
  const order = paidOrder();
  order.items[0].itemStatus = 'cancelled';
  const refund = await refundItems(order, [order.items[0]], { reason: 'seller rejected' });

  assert.equal(refund.amount, 500);
  assert.equal(refundCalls.at(-1).paymentId, 'pay_1');
  assert.equal(refundCalls.at(-1).body.amount, 50000);
  assert.equal(order.refundStatus, 'refund_pending');
  assert.equal(order.refundedAmount, 500);
});

test('never refunds the same item twice', async () => {
  const order = paidOrder();
  order.items[0].itemStatus = 'cancelled';
  await refundItems(order, [order.items[0]]);
  const calls = refundCalls.length;
  const second = await refundItems(order, [order.items[0]]);
  assert.equal(second, null);
  assert.equal(refundCalls.length, calls);
});

test('adds shipping once the whole order is cancelled before shipping', async () => {
  const order = paidOrder();
  order.items.forEach((i) => (i.itemStatus = 'cancelled'));
  const refund = await refundItems(order, order.items);
  assert.equal(refund.amount, 849);
  assert.equal(refund.includesShipping, true);
});

test('COD and unpaid orders are not refunded through Razorpay', async () => {
  const cod = paidOrder();
  cod.paymentMethod = 'COD';
  assert.equal(await refundItems(cod, cod.items), null);
  const unpaid = paidOrder();
  unpaid.paymentStatus = 'pending';
  assert.equal(await refundItems(unpaid, unpaid.items), null);
});

test('a Razorpay rejection is recorded as failed and can be retried', async () => {
  const order = paidOrder();
  order.items[1].itemStatus = 'cancelled';
  nextRefundError = { error: { description: 'Insufficient balance' } };
  const refund = await refundItems(order, [order.items[1]]);
  assert.equal(refund.status, 'failed');
  assert.match(refund.error, /Insufficient balance/);
  assert.equal(order.refundStatus, 'refund_failed');

  await retryRefund(order, refund._id);
  assert.equal(refund.status, 'pending');
  assert.equal(order.refundStatus, 'refund_pending');
});

test('refund.processed webhooks roll up to partially_refunded, then refunded', async () => {
  const order = paidOrder();
  order.items[0].itemStatus = 'cancelled';
  const first = await refundItems(order, [order.items[0]]);
  applyRefundWebhook(order, { id: first.razorpayRefundId, amount: 50000 }, 'processed');
  assert.equal(order.refundStatus, 'partially_refunded');
  assert.equal(order.paymentStatus, 'paid');

  order.items[1].itemStatus = 'cancelled';
  const second = await refundItems(order, [order.items[1]]);
  assert.equal(second.amount, 349); // 300 + shipping now that nothing will ship
  applyRefundWebhook(order, { id: second.razorpayRefundId, amount: 34900 }, 'processed');
  assert.equal(order.refundStatus, 'refunded');
  assert.equal(order.paymentStatus, 'refunded');
});
