const asyncHandler = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (error) {
    console.error(`[${req.method} ${req.originalUrl}]`, error);
    next(error);
  }
};

module.exports = asyncHandler;
