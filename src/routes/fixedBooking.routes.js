const express = require("express");
const {
  listFixedBookingsHandler,
  createFixedBooking,
  updateFixedBooking,
  deleteFixedBooking,
} = require("../controllers/fixedBooking.controller");

const router = express.Router();

router.get("/", listFixedBookingsHandler);
router.post("/", createFixedBooking);
router.put("/:id", updateFixedBooking);
router.delete("/:id", deleteFixedBooking);

module.exports = router;
