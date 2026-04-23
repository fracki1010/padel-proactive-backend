const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET;

// Middleware obligatorio: rechaza si no hay token de cliente válido
const protectClient = (req, res, next) => {
  let token;
  if (req.headers.authorization?.startsWith("Bearer")) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return res.status(401).json({ success: false, error: "No autorizado" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== "client") {
      return res.status(401).json({ success: false, error: "Token inválido" });
    }
    req.clientUser = decoded;
    return next();
  } catch {
    return res.status(401).json({ success: false, error: "Token inválido" });
  }
};

// Middleware opcional: no rechaza, sólo adjunta req.clientUser si el token es válido
const optionalClient = (req, _res, next) => {
  let token;
  if (req.headers.authorization?.startsWith("Bearer")) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.type === "client") {
        req.clientUser = decoded;
      }
    } catch {
      // token inválido, simplemente no se adjunta
    }
  }

  return next();
};

module.exports = { protectClient, optionalClient };
