const express = require("express");
const router = express.Router();
const {
  getNotifications,
  markAsRead,
  markAllAsRead,
  sendTestAdminNotification,
} = require("../controllers/notification.controller");

router.get("/", getNotifications);
router.post("/send-test", sendTestAdminNotification);
router.put("/mark-all-read", markAllAsRead);
router.put("/:id/read", markAsRead);

module.exports = router;
