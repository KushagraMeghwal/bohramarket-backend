require('dotenv').config();
const env = require('./config/env');
// Before anything touches the database: a non-production server must be
// pointed at a *_dev / *_test database, never the live one.
env.assertSafeDatabase();
env.reportMissingSecrets();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const connectDB = require('./config/db');
const { runMigrations } = require('./utils/migrations');
require('./config/cloudinary');

const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const adminRoutes = require('./routes/adminRoutes');
const sellerRoutes = require('./routes/sellerRoutes');
const cartRoutes = require('./routes/cartRoutes');
const orderRoutes = require('./routes/orderRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const homepageRoutes = require('./routes/homepageRoutes');
const siteContentRoutes = require('./routes/siteContentRoutes');
const addressRoutes = require('./routes/addressRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const sellerOrderActionRoutes = require('./routes/sellerOrderActionRoutes');
const checkoutRoutes = require('./routes/checkoutRoutes');
const configRoutes = require('./routes/configRoutes');
const shipmentJobQueue = require('./services/shipmentJobQueue.service');
const sellerResponseWindow = require('./services/sellerResponseWindow.service');
// Side-effecting require: registers every fulfillment-chain step handler
// (ensure_pickup..generate_invoice) with shipmentJobQueue. Must be required
// before startWorker() below processes anything, and before any request
// can enqueue a job (sellerOrderActionController.acceptSellerItem).
require('./services/fulfillment.service');

connectDB().then(() => runMigrations()).catch((err) => console.error('[boot] migrations failed', err));

// Starts the in-process job-queue worker (retries Shiprocket fulfillment
// steps on failure — see shipmentJobQueue.service.js).
shipmentJobQueue.startWorker();

// Auto-cancels order items a seller never responded to within the response
// window (see sellerResponseWindow.service.js).
sellerResponseWindow.startWorker();

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');
// API-only server: no HTML is served, so the defaults (nosniff, frameguard,
// HSTS, no-referrer, ...) are all safe; CORP is relaxed so the storefront
// origin can read JSON responses.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

const allowedOrigins = [
  'https://bohramart-6e152.web.app',
  'https://bohramart-6e152.firebaseapp.com',
  // The local dev frontend is only allowed against a non-production API.
  ...(env.isProduction ? [] : ['http://localhost:4200', 'http://127.0.0.1:4200']),
  ...(process.env.EXTRA_CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean),
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Must be mounted before express.json(): Razorpay signs the exact raw
// request bytes, and once express.json() parses+re-serializes a body the
// HMAC in webhookController would no longer match. This router applies its
// own express.raw() scoped to just the webhook path; every other route
// still gets the normal parsed JSON body below.
app.use('/api/webhooks', webhookRoutes);

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// Rate limits (per client IP; Cloud Run's proxy is trusted above). Auth
// endpoints get a tight budget — they're the brute-force / email-spam
// targets — everything else a generous one.
const limiter = (windowMinutes, max, message) =>
  rateLimit({ windowMs: windowMinutes * 60 * 1000, limit: max, standardHeaders: 'draft-7', legacyHeaders: false, message: { message } });
app.use(
  ['/api/auth/login', '/api/auth/register', '/api/auth/verify-otp', '/api/auth/resend-otp', '/api/auth/forgot-password', '/api/auth/reset-password', '/api/auth/google'],
  limiter(15, 30, 'Too many attempts. Please wait a few minutes and try again.')
);
app.use('/api/checkout/delivery-estimate', limiter(1, 20, 'Too many delivery checks. Please slow down.'));
app.use('/api', limiter(1, 300, 'Too many requests. Please slow down.'));

app.get('/', (req, res) => res.send('BohraMarket API running'));

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/sellers', sellerRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/homepage', homepageRoutes);
app.use('/api/site-content', siteContentRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/seller/orders', sellerOrderActionRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/config', configRoutes);

app.use((req, res) => res.status(404).json({ message: 'Route not found' }));

app.use((err, req, res, next) => {
  // Cloudinary/network errors are sometimes plain objects rather than Error
  // instances, so console.error(err) alone can print as "{}" and hide the
  // actual reason — log the fields we actually care about explicitly.
  console.error(`[${req.method} ${req.originalUrl}]`, {
    name: err?.name,
    message: err?.message,
    http_code: err?.http_code,
    code: err?.code,
    stack: err?.stack,
  });

  if (err.name === 'MulterError') {
    const friendly = {
      LIMIT_FILE_SIZE: 'A file is too large — photos must be under 5 MB (documents under 10 MB).',
      LIMIT_FILE_COUNT: 'Too many files — you can upload up to 6 product photos.',
      LIMIT_UNEXPECTED_FILE: 'Too many files, or a file was sent in the wrong field.',
    };
    return res.status(400).json({ message: friendly[err.code] || err.message || 'File upload failed' });
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      message: 'Validation failed',
      errors: Object.values(err.errors || {}).map((fieldError) => fieldError.message),
    });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({ message: `Invalid ${err.path}` });
  }

  if (err.code === 11000) {
    return res.status(409).json({ message: 'A record with this value already exists' });
  }

  if (typeof err.message === 'string' && /format .* not allowed/i.test(err.message)) {
    return res.status(400).json({ message: err.message });
  }

  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ message: 'Origin not allowed' });
  }

  const status = err.statusCode || err.status || 500;
  // Internal error text (DB / SDK messages) is only shown outside production.
  res.status(status).json({
    message: status >= 500 && env.isProduction ? 'Something went wrong. Please try again.' : err.message || 'Server error',
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
