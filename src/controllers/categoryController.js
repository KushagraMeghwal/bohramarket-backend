const Category = require('../models/Category');
const asyncHandler = require('../utils/asyncHandler');

// POST /api/categories
const createCategory = asyncHandler(async (req, res) => {
  const { name, slug, description, parentCategory, sortOrder } = req.body;

  if (!name || !slug) {
    return res.status(400).json({ message: 'Name and slug are required' });
  }

  const image = req.file ? { url: req.file.path, publicId: req.file.filename } : undefined;

  const category = await Category.create({
    name,
    slug,
    description,
    parentCategory: parentCategory || null,
    sortOrder,
    image,
  });

  res.status(201).json({ category });
});

// GET /api/categories
const getCategories = asyncHandler(async (req, res) => {
  const filter = req.user?.role === 'admin' && req.query.includeInactive === 'true' ? {} : { isActive: true };

  const categories = await Category.find(filter)
    .populate('parentCategory', 'name slug')
    .sort('sortOrder');

  res.json({ categories });
});

// GET /api/categories/:id
const getCategoryById = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id).populate('parentCategory', 'name slug');

  if (!category) {
    return res.status(404).json({ message: 'Category not found' });
  }

  res.json({ category });
});

// PUT /api/categories/:id
const updateCategory = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);
  if (!category) {
    return res.status(404).json({ message: 'Category not found' });
  }

  const editableFields = ['name', 'slug', 'description', 'parentCategory', 'isActive', 'sortOrder'];
  editableFields.forEach((field) => {
    if (req.body[field] === undefined) return;
    category[field] = field === 'parentCategory' ? req.body[field] || null : req.body[field];
  });

  if (req.file) {
    category.image = { url: req.file.path, publicId: req.file.filename };
  }

  await category.save();
  res.json({ category });
});

// DELETE /api/categories/:id
const deleteCategory = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);
  if (!category) {
    return res.status(404).json({ message: 'Category not found' });
  }

  await category.deleteOne();
  res.json({ message: 'Category deleted' });
});

module.exports = { createCategory, getCategories, getCategoryById, updateCategory, deleteCategory };
