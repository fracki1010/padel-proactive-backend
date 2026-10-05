const express = require("express");
const {
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  toggleAnnouncement,
} = require("../controllers/announcement.controller");

const router = express.Router();

router.get("/", listAnnouncements);
router.post("/", createAnnouncement);
router.put("/:id", updateAnnouncement);
router.delete("/:id", deleteAnnouncement);
router.patch("/:id/toggle", toggleAnnouncement);

module.exports = router;
