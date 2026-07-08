const https = require('https');

let cachedOffsetSeconds = null;
let offsetPromise = null;

function fetchServerDate() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { method: 'GET', hostname: 'api.cloudinary.com', path: '/v1_1/ping', timeout: 5000 },
      (res) => {
        res.resume(); // drain the body, we only care about the Date header
        const dateHeader = res.headers['date'];
        if (!dateHeader) return reject(new Error('Cloudinary response had no Date header'));
        resolve(new Date(dateHeader).getTime());
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timed out fetching Cloudinary server time')));
    req.end();
  });
}

// Cloudinary rejects a signed upload if the `timestamp` it's signed with
// drifts more than ~1 hour from Cloudinary's own clock. On a host whose
// system clock is wrong (common in sandboxes/containers), every signed
// upload fails with "Stale request" even though nothing is actually wrong
// with the request. This measures the drift once per process against
// Cloudinary's own Date header and nudges every upload timestamp by it.
async function getCloudinaryTimestamp() {
  if (cachedOffsetSeconds === null) {
    offsetPromise ??= fetchServerDate()
      .then((serverMs) => {
        cachedOffsetSeconds = Math.round((serverMs - Date.now()) / 1000);
      })
      .catch(() => {
        cachedOffsetSeconds = 0; // fall back to trusting the local clock
      });
    await offsetPromise;
  }
  return Math.floor(Date.now() / 1000) + cachedOffsetSeconds;
}

module.exports = { getCloudinaryTimestamp };
