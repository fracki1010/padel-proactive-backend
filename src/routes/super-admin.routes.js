const express = require("express");
const router = express.Router();
const {
  listCompanies,
  createCompany,
  updateCompany,
  updateCompanyStatus,
  listAdmins,
  createAdmin,
  updateAdminStatus,
  bootstrapDefaultTenant,
} = require("../controllers/superAdmin.controller");

router.get("/companies", listCompanies);
router.post("/companies", createCompany);
router.put("/companies/:id", updateCompany);
router.put("/companies/:id/status", updateCompanyStatus);

router.get("/admins", listAdmins);
router.post("/admins", createAdmin);
router.put("/admins/:id/status", updateAdminStatus);
router.post("/bootstrap/default-tenant", bootstrapDefaultTenant);

module.exports = router;
