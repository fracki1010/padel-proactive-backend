// src/middleware/auth.middleware.js
const jwt = require("jsonwebtoken");

const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return res
      .status(401)
      .json({
        success: false,
        error: "No autorizado para acceder a esta ruta",
      });
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "fallback_secret",
    );
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: "Token inválido" });
  }
};

const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user?.role) {
      return res.status(403).json({
        success: false,
        error: "No tenés permisos para acceder a este recurso",
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: "No tenés permisos para acceder a este recurso",
      });
    }

    return next();
  };
};

const requireTenant = (req, res, next) => {
  if (req.user?.role === "super_admin") return next();

  if (!req.user?.companyId) {
    return res.status(403).json({
      success: false,
      error: "El usuario no tiene una empresa asignada",
    });
  }

  req.tenantId = String(req.user.companyId);
  return next();
};

const tenantFilter = (req, extraFilter = {}) => {
  if (req.user?.role === "super_admin") return { ...extraFilter };
  if (!req.user?.companyId) return { ...extraFilter, _id: null };
  return { ...extraFilter, companyId: req.user.companyId };
};

module.exports = { protect, requireRole, requireTenant, tenantFilter };
