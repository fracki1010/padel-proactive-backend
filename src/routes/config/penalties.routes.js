'use strict';

const express = require('express');
const router = express.Router();
const { resolveCompanyId } = require('./shared');
const {
  DEFAULT_PENALTY_LIMIT,
  getPenaltyLimit,
  getPenaltySystemEnabled,
  setPenaltyLimit,
} = require('../../services/appConfig.service');

// GET /api/config/penalties
router.get("/penalties", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const [penaltyLimit, penaltySystemEnabled] = await Promise.all([
      getPenaltyLimit(companyId),
      getPenaltySystemEnabled(companyId),
    ]);
    return res.status(200).json({
      success: true,
      data: {
        penaltyLimit,
        penaltyEnabled: penaltySystemEnabled,
        penaltySystemEnabled,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/config/penalties
router.put("/penalties", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const rawPenaltyLimit = req.body?.penaltyLimit;
    const parsed = Number(rawPenaltyLimit);

    if (!Number.isInteger(parsed) || parsed < 1) {
      return res.status(400).json({
        success: false,
        error: `El campo 'penaltyLimit' debe ser un entero mayor o igual a 1. Valor recomendado por defecto: ${DEFAULT_PENALTY_LIMIT}.`,
      });
    }

    const config = await setPenaltyLimit(parsed, companyId);
    return res.status(200).json({
      success: true,
      data: { penaltyLimit: config.penaltyLimit },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;