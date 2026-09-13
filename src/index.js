require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const connectDB = require('./config/db');
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
const shipmentJobQueue = require('./services/shipmentJobQueue.service');
const sellerResponseWindow = require('./services/sellerResponseWindow.service');
// Side-effecting require: registers every fulfillment-chain step handler
// (ensure_pickup..generate_invoice) with shipmentJobQueue. Must be required
// before startWorker() below processes anything, and before any request
// can enqueue a job (sellerOrderActionController.acceptSellerItem).
require('./services/fulfillment.service');

connectDB();

// Starts the in-process job-queue worker (retries Shiprocket fulfillment
// steps on failure — see shipmentJobQueue.service.js).
shipmentJobQueue.startWorker();

// Auto-cancels order items a seller never responded to within the response
// window (see sellerResponseWindow.service.js).
sellerResponseWindow.startWorker();

const app = express();

app.set('trust proxy', 1);

const allowedOrigins = [
  'https://bohramart-6e152.web.app',
  'https://bohramart-6e152.firebaseapp.com',
  'http://localhost:4200'
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

app.use(express.json());
app.use(cookieParser());

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
    return res.status(400).json({ message: err.message || 'File upload failed' });
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

  res.status(err.statusCode || 500).json({
    message: err.message || 'Server error',
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
