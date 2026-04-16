const express = require("express");
const router = express.Router();
const {
  listCommands,
  getCommandStatus,
  retryCommand,
  sendMessage,
  restartWhatsapp,
  listGroupsSnapshot,
} = require("../controllers/whatsapp.controller");

router.get("/commands", listCommands);
router.get("/commands/:id", getCommandStatus);
router.post("/commands/:id/retry", retryCommand);
router.get("/groups", listGroupsSnapshot);
router.get("/chats", listGroupsSnapshot);
router.post("/send", sendMessage);
router.post("/restart", restartWhatsapp);

module.exports = router;
