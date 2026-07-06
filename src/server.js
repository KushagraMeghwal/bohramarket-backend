require('dotenv').config();
const express = require('express');
const connectDB = require('./config/db');
const cloudinary = require('./config/cloudinary');
console.log('Cloudinary configured:', cloudinary.config().cloud_name);
connectDB();

const app = express();

app.get('/', (req, res) => res.send('BohraMarket API running'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));