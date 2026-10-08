// In-memory sliding-window rate limiter. Used on public endpoints (portal OTP,
// payment links) and the unauthenticated MercadoPago webhook, so the tracked
// key map MUST stay bounded: expired windows are dropped on access and the
// oldest key is evicted when `maxTrackedKeys` is reached.

const DEFAULT_MAX_TRACKED_KEYS = 10_000;

const createRateLimiter = ({
  windowMs = 60_000,
  maxRequests = 30,
  keyGenerator,
  maxTrackedKeys = DEFAULT_MAX_TRACKED_KEYS,
} = {}) => {
  const requestsByKey = new Map();
  const resolveKey = keyGenerator || ((req) => req.ip || "unknown");
  const trackedKeyCount = () => requestsByKey.size;

  const limiter = (req, res, next) => {
    const key = resolveKey(req);
    const now = Date.now();
    const windowStart = now - windowMs;

    // Drop timestamps that fell out of the window for this key.
    const current = (requestsByKey.get(key) || []).filter(
      (timestamp) => timestamp > windowStart,
    );

    // Bounded memory: evict the oldest key when the cap is hit (the Map keeps
    // insertion order, so `keys().next()` is the least-recently inserted).
    if (!requestsByKey.has(key) && requestsByKey.size >= maxTrackedKeys) {
      const oldestKey = requestsByKey.keys().next().value;
      requestsByKey.delete(oldestKey);
    }

    if (current.length >= maxRequests) {
      return res.status(429).json({
        success: false,
        error: "Demasiadas solicitudes. Intentá nuevamente en unos segundos.",
      });
    }

    current.push(now);
    requestsByKey.set(key, current);
    return next();
  };

  limiter.trackedKeyCount = trackedKeyCount;
  return limiter;
};

module.exports = { createRateLimiter };