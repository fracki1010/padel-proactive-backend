const express = require("express");
const router = express.Router();
const {
  sendMessage,
  restartWhatsapp,
} = require("../controllers/whatsapp.controller");

router.post("/send", sendMessage);
router.post("/restart", restartWhatsapp);

module.exports = router;
