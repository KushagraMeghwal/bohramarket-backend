// Simulates a Razorpay webhook delivery against a locally running server, so
// the signature-verification + event-handling path in webhookController.js
// can be exercised before wiring the real URL into the Razorpay dashboard.
//
// Usage:
//   RAZORPAY_WEBHOOK_SECRET=<same value the local server reads from .env> \
//   node scripts/test-razorpay-webhook.js [event] [razorpayOrderId]
//
// Examples:
//   node scripts/test-razorpay-webhook.js payment.captured order_ABC123
//   node scripts/test-razorpay-webhook.js payment.failed order_ABC123
//   node scripts/test-razorpay-webhook.js order.paid order_ABC123
//   node scripts/test-razorpay-webhook.js refund.processed pay_ABC123
//
// For payment.captured/payment.failed/order.paid, pass the razorpay orderId
// stored on the Order document you want updated (order.razorpay.orderId).
// For refund.processed, pass the razorpay paymentId instead
// (order.razorpay.paymentId), since refunds are looked up by payment id.

require('dotenv').config();
const crypto = require('crypto');

const TARGET_URL = process.env.WEBHOOK_TEST_URL || 'http://localhost:5000/api/webhooks/razorpay';
const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

if (!SECRET) {
  console.error('Set RAZORPAY_WEBHOOK_SECRET (matching your local .env) before running this script.');
  process.exit(1);
}

const [, , eventArg, idArg] = process.argv;
const event = eventArg || 'payment.captured';
const id = idArg || 'order_TESTID123';
const now = Math.floor(Date.now() / 1000);

function buildPayload() {
  switch (event) {
    case 'payment.captured':
      return {
        event,
        payload: {
          payment: {
            entity: {
              id: 'pay_TESTPAYMENTID',
              order_id: id,
              method: 'upi',
              status: 'captured',
              created_at: now,
            },
          },
        },
      };
    case 'payment.failed':
      return {
        event,
        payload: {
          payment: {
            entity: {
              id: 'pay_TESTPAYMENTID',
              order_id: id,
              error_code: 'BAD_REQUEST_ERROR',
              error_description: 'Payment failed (simulated)',
              created_at: now,
            },
          },
        },
      };
    case 'order.paid':
      return {
        event,
        payload: {
          order: { entity: { id, status: 'paid' } },
        },
      };
    case 'refund.processed':
      return {
        event,
        payload: {
          refund: {
            entity: { id: 'rfnd_TESTREFUNDID', payment_id: id, status: 'processed' },
          },
        },
      };
    default:
      console.error(`Unknown event type "${event}". See the usage comment at the top of this file.`);
      process.exit(1);
  }
}

async function main() {
  const body = JSON.stringify(buildPayload());
  const signature = crypto.createHmac('sha256', SECRET).update(body).digest('hex');

  const res = await fetch(TARGET_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-razorpay-signature': signature,
    },
    body,
  });

  console.log(`POST ${TARGET_URL} -> ${res.status}`);
  console.log(await res.text());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
