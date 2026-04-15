const express = require("express");
const router = express.Router();
const {
  listCommands,
  getCommandStatus,
  retryCommand,
  sendMessage,
  restartWhatsapp,
} = require("../controllers/whatsapp.controller");

router.get("/commands", listCommands);
router.get("/commands/:id", getCommandStatus);
router.post("/commands/:id/retry", retryCommand);
router.post("/send", sendMessage);
router.post("/restart", restartWhatsapp);

module.exports = router;
