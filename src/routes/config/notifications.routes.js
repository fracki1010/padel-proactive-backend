'use strict';

const express = require('express');
const router = express.Router();
const {
  resolveCompanyId,
  firstBoolean,
} = require('./shared');
const {
  getOneHourReminderEnabled,
  setOneHourReminderEnabled,
} = require('../../services/appConfig.service');

// GET /api/config/notifications/reminders
router.get("/notifications/reminders", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const enabled = await getOneHourReminderEnabled(companyId);
    return res.status(200).json({
      success: true,
      data: {
        oneHourReminderEnabled: enabled,
        oneHourBeforeEnabled: enabled,
        bookingReminderOneHourEnabled: enabled,
        notifyOneHourBeforeMatch: enabled,
        notifyOneHourBeforeBooking: enabled,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

const updateOneHourReminderConfig = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const body = req.body || {};
    const enabledCandidate = firstBoolean([
      body.oneHourReminderEnabled,
      body.oneHourBeforeEnabled,
      body.bookingReminderOneHourEnabled,
      body.notifyOneHourBeforeMatch,
      body.notifyOneHourBeforeBooking,
    ]);

    if (typeof enabledCandidate !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "Debés enviar un booleano para el recordatorio de 1 hora.",
      });
    }

    const updated = await setOneHourReminderEnabled(enabledCandidate, companyId);
    const enabled =
      typeof updated.oneHourReminderEnabled === "boolean"
        ? updated.oneHourReminderEnabled
        : Boolean(enabledCandidate);

    return res.status(200).json({
      success: true,
      data: {
        oneHourReminderEnabled: enabled,
        oneHourBeforeEnabled: enabled,
        bookingReminderOneHourEnabled: enabled,
        notifyOneHourBeforeMatch: enabled,
        notifyOneHourBeforeBooking: enabled,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// PUT/PATCH /api/config/notifications/reminders
router.put("/notifications/reminders", updateOneHourReminderConfig);
router.patch("/notifications/reminders", updateOneHourReminderConfig);

// Compatibility aliases used by frontend fallbacks.
router.get("/settings", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const enabled = await getOneHourReminderEnabled(companyId);
    return res.status(200).json({
      success: true,
      data: {
        oneHourReminderEnabled: enabled,
        bookingReminderOneHourEnabled: enabled,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});
router.put("/settings", updateOneHourReminderConfig);
router.patch("/settings", updateOneHourReminderConfig);

module.exports = router;