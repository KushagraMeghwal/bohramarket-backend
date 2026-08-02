const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');

const REQUIRED_FIELDS = ['fullName', 'phone', 'line1', 'city', 'state', 'pincode'];

const validateAddress = (body) => REQUIRED_FIELDS.filter((field) => !body[field]);

// GET /api/addresses
const getAddresses = asyncHandler(async (req, res) => {
  res.json({ addresses: req.user.addresses });
});

// POST /api/addresses
const addAddress = asyncHandler(async (req, res) => {
  const missing = validateAddress(req.body);
  if (missing.length) {
    return res.status(400).json({ message: `Missing required fields: ${missing.join(', ')}` });
  }

  const { label, fullName, phone, line1, line2, city, state, pincode, country, isDefault } = req.body;
  const isFirstAddress = req.user.addresses.length === 0;

  if (isDefault || isFirstAddress) {
    req.user.addresses.forEach((address) => {
      address.isDefault = false;
    });
  }

  req.user.addresses.push({
    label,
    fullName,
    phone,
    line1,
    line2,
    city,
    state,
    pincode,
    country,
    isDefault: isDefault || isFirstAddress,
  });

  await req.user.save();
  res.status(201).json({ addresses: req.user.addresses });
});

// PATCH /api/addresses/:addressId
const updateAddress = asyncHandler(async (req, res) => {
  const address = req.user.addresses.id(req.params.addressId);
  if (!address) {
    return res.status(404).json({ message: 'Address not found' });
  }

  const { label, fullName, phone, line1, line2, city, state, pincode, country, isDefault } = req.body;

  if (label !== undefined) address.label = label;
  if (fullName !== undefined) address.fullName = fullName;
  if (phone !== undefined) address.phone = phone;
  if (line1 !== undefined) address.line1 = line1;
  if (line2 !== undefined) address.line2 = line2;
  if (city !== undefined) address.city = city;
  if (state !== undefined) address.state = state;
  if (pincode !== undefined) address.pincode = pincode;
  if (country !== undefined) address.country = country;

  if (isDefault) {
    req.user.addresses.forEach((entry) => {
      entry.isDefault = entry._id.equals(address._id);
    });
  }

  await req.user.save();
  res.json({ addresses: req.user.addresses });
});

// DELETE /api/addresses/:addressId
const deleteAddress = asyncHandler(async (req, res) => {
  const address = req.user.addresses.id(req.params.addressId);
  if (!address) {
    return res.status(404).json({ message: 'Address not found' });
  }

  const wasDefault = address.isDefault;
  address.deleteOne();

  if (wasDefault && req.user.addresses.length > 0) {
    req.user.addresses[0].isDefault = true;
  }

  await req.user.save();
  res.json({ addresses: req.user.addresses });
});

// PATCH /api/addresses/:addressId/default
const setDefaultAddress = asyncHandler(async (req, res) => {
  const address = req.user.addresses.id(req.params.addressId);
  if (!address) {
    return res.status(404).json({ message: 'Address not found' });
  }

  req.user.addresses.forEach((entry) => {
    entry.isDefault = entry._id.equals(address._id);
  });

  await req.user.save();
  res.json({ addresses: req.user.addresses });
});

module.exports = { getAddresses, addAddress, updateAddress, deleteAddress, setDefaultAddress };
