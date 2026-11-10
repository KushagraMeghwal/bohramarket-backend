// Central place for environment-dependent behavior. Everything that differs
// between local development and production (which database, whether dev-only
// shortcuts like returning OTPs in responses are allowed, which secrets are
// mandatory) is decided here, once, at boot.
const isProduction = process.env.NODE_ENV === 'production';

// Local development must never point at the production database — a dev
// server talking to live data means every test order, test account and
// test refund lands on real customers and sellers. Outside production the
// database name has to be explicitly marked as a dev/test database.
const DEV_DB_NAME_PATTERN = /(_dev|_test|-dev|-test)$/i;

function databaseNameFromUri(uri) {
  if (!uri) return null;
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/);
  return match && match[1] ? decodeURIComponent(match[1]) : null;
}

function assertSafeDatabase() {
  if (isProduction) return;
  const dbName = databaseNameFromUri(process.env.MONGO_URI);
  if (!dbName || !DEV_DB_NAME_PATTERN.test(dbName)) {
    console.error(
      `[env] Refusing to start: NODE_ENV=${process.env.NODE_ENV || '(unset)'} but MONGO_URI points at database "${dbName || 'test (default)'}". ` +
        'Non-production servers must use a database whose name ends in _dev or _test (e.g. .../bohramart_dev?...), ' +
        'so local testing can never touch production data.'
    );
    process.exit(1);
  }
}

// Secrets without which a production deployment is unsafe or broken. Missing
// ones are logged loudly at boot; the features that depend on them refuse to
// run (e.g. auth email endpoints return 503) rather than silently degrading
// into something insecure.
const REQUIRED_IN_PRODUCTION = [
  'MONGO_URI',
  'JWT_SECRET',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'SHIPROCKET_WEBHOOK_TOKEN',
  'FIELD_ENCRYPTION_KEY',
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASS',
];

function reportMissingSecrets() {
  const required = isProduction ? REQUIRED_IN_PRODUCTION : ['MONGO_URI', 'JWT_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error(`[env] Missing required env vars (${isProduction ? 'production' : 'development'}): ${missing.join(', ')}`);
  }
  return missing;
}

const isRazorpayConfigured = () => !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

module.exports = { isProduction, assertSafeDatabase, reportMissingSecrets, databaseNameFromUri, isRazorpayConfigured };
