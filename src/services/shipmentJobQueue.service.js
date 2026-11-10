// Generic job scheduling/retry/persistence for the Shiprocket fulfillment
// chain. Deliberately knows nothing about *what* each step does — that's
// registered from fulfillment.service.js (PART 2.6) via registerStepHandler.
// This separation is what lets 2.4 (this file) be finished and tested with a
// dummy handler before 2.6's real Shiprocket calls exist.
const ShipmentJob = require('../models/ShipmentJob');
const Order = require('../models/Order');
const Seller = require('../models/Seller');
const { withRetry } = require('./shiprocketRetry.service');
const { startInterval } = require('../utils/scheduler');
const notificationService = require('./notification.service');

const MAX_JOB_ATTEMPTS = Number(process.env.SHIPMENT_JOB_MAX_ATTEMPTS) || 3;
const POLL_INTERVAL_MS = Number(process.env.SHIPMENT_JOB_POLL_INTERVAL_MS) || 30000;

// step -> async (order, seller, job) => { nextStep: string | null }
const stepHandlers = new Map();

function registerStepHandler(step, handler) {
  if (!ShipmentJob.STEPS.includes(step)) {
    throw new Error(`registerStepHandler: unknown step "${step}"`);
  }
  stepHandlers.set(step, handler);
}

// Idempotent: re-enqueuing an (order, seller, step) that already has a job
// resets it to pending rather than creating a duplicate, thanks to the
// unique index on ShipmentJob. This is also how a failed job gets manually
// re-queued from the admin "Retry fulfillment" action (PART 2.12).
async function enqueueJob({ orderId, sellerId, step }) {
  return ShipmentJob.findOneAndUpdate(
    { order: orderId, seller: sellerId, step },
    {
      $set: { status: 'pending', nextRetryAt: new Date(), lastError: undefined },
      $setOnInsert: { attempts: 0 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function runJob(job) {
  const handler = stepHandlers.get(job.step);
  if (!handler) {
    console.error(`[shipment-jobs] no handler registered for step "${job.step}" — skipping job ${job._id}`);
    return;
  }

  job.status = 'processing';
  await job.save();

  const [order, seller] = await Promise.all([Order.findById(job.order), Seller.findById(job.seller)]);

  if (!order || !seller) {
    job.status = 'needs_attention';
    job.lastError = `order or seller no longer exists (order=${!!order}, seller=${!!seller})`;
    await job.save();
    return;
  }

  try {
    const result = await withRetry(() => handler(order, seller, job), {
      label: `${job.step} (order ${order.orderNumber})`,
    });

    job.status = 'done';
    job.lastError = undefined;
    await job.save();

    if (result?.nextStep) {
      await enqueueJob({ orderId: job.order, sellerId: job.seller, step: result.nextStep });
    }
  } catch (err) {
    job.attempts += 1;
    // Permanent errors (Shiprocket permission refusals) carry a plain-English
    // explanation of what to fix; keep the raw response after it for support.
    job.lastError = err.adminHint ? `${err.adminHint} [${err.message}]` : err.message || String(err);

    if (err.permanent || job.attempts >= MAX_JOB_ATTEMPTS) {
      job.status = 'needs_attention';
      console.error(
        `[shipment-jobs] job ${job._id} (${job.step}, order ${order.orderNumber}) needs attention after ${job.attempts} attempt(s): ${job.lastError}`
      );
      notificationService.notifyAdmin(
        `Shipping for order ${order.orderNumber} (${seller.businessName}) is stuck at "${job.step.replace(/_/g, ' ')}": ${err.adminHint || job.lastError}`
      );
    } else {
      job.status = 'pending';
      // Backoff at the job-scheduling level (minutes) — separate from, and
      // on top of, shiprocketRetry's own per-call backoff (milliseconds),
      // since this spans queue polls rather than one function's retries.
      const backoffMinutes = 2 ** job.attempts; // 2, 4, 8 minutes
      job.nextRetryAt = new Date(Date.now() + backoffMinutes * 60 * 1000);
      console.warn(
        `[shipment-jobs] job ${job._id} (${job.step}, order ${order.orderNumber}) attempt ${job.attempts} failed, retrying at ${job.nextRetryAt.toISOString()}: ${job.lastError}`
      );
    }
    await job.save();
  }
}

// Sequential, not parallel — this app has no worker-pool infra, and running
// jobs one at a time is also gentler on Shiprocket's own rate limits.
async function processPendingJobs() {
  const dueJobs = await ShipmentJob.find({ status: 'pending', nextRetryAt: { $lte: new Date() } }).sort('nextRetryAt');
  for (const job of dueJobs) {
    await runJob(job);
  }
  return { processed: dueJobs.length };
}

function startWorker() {
  return startInterval('shipment-job-queue', processPendingJobs, POLL_INTERVAL_MS);
}

module.exports = { enqueueJob, registerStepHandler, processPendingJobs, startWorker };
