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

module.exports = { protect };
