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
const webhookRoutes = require('./routes/webhookRoutes');

connectDB();

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

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/sellers', sellerRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/homepage', homepageRoutes);

app.use((req, res) => res.status(404).json({ message: 'Route not found' }));

app.use((err, req, res, next) => {
  console.error(`[${req.method} ${req.originalUrl}]`, err);

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
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
