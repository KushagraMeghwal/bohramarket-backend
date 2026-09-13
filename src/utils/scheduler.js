// Minimal in-process interval scheduler. This project has no cron/job
// library (checked package.json before adding one — only express/mongoose/
// razorpay/etc, no node-cron/agenda/bull); a plain setInterval matches the
// existing code style and is sufficient at this app's current scale.
//
// IMPORTANT caveat: on Cloud Run with min-instances=0, this only runs while
// at least one instance is warm and handling traffic — it does NOT run
// during scale-to-zero idle periods, so a job or the seller auto-cancel
// window can sit un-advanced until the next request wakes an instance.
// Anything time-sensitive also re-checks itself opportunistically on
// relevant read paths (see shipmentJobQueue.service.js and the seller
// auto-cancel check) so a cold instance catches up immediately on wake
// rather than waiting for the next interval tick. For guaranteed
// wall-clock timeliness even with zero traffic, wire an external trigger
// (e.g. Cloud Scheduler hitting an authenticated internal endpoint) —
// not implemented here, flagged as a follow-up in the final report.
function startInterval(name, fn, intervalMs) {
  console.log(`[scheduler] starting "${name}" every ${intervalMs}ms`);
  const timer = setInterval(() => {
    fn().catch((err) => console.error(`[scheduler] "${name}" run failed`, err));
  }, intervalMs);
  timer.unref?.(); // never block process exit on this alone
  return timer;
}

module.exports = { startInterval };
