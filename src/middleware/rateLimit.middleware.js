const createRateLimiter = ({
  windowMs = 60_000,
  maxRequests = 30,
  keyGenerator = (req) => req.ip || "unknown",
} = {}) => {
  const requestsByKey = new Map();

  return (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();
    const windowStart = now - windowMs;
    const current = requestsByKey.get(key) || [];
    const recent = current.filter((timestamp) => timestamp > windowStart);

    if (recent.length >= maxRequests) {
      return res.status(429).json({
        success: false,
        error: "Demasiadas solicitudes. Intentá nuevamente en unos segundos.",
      });
    }

    recent.push(now);
    requestsByKey.set(key, recent);
    return next();
  };
};

module.exports = { createRateLimiter };
