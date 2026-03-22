const mongoose = require("mongoose");
const Booking = require("../src/models/booking.model");

require("dotenv").config();

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to DB.");

    try {
      await Booking.collection.dropIndex("court_1_date_1_timeSlot_1");
      console.log("Old unique index dropped successfully.");
    } catch (err) {
      if (err.code === 27) {
        console.log("Index not found, continuing...");
      } else {
        console.error("Error dropping index:", err);
      }
    }

    // Force sync indexes
    await Booking.syncIndexes();
    console.log("Indexes synchronized.");

    mongoose.disconnect();
  } catch (error) {
    console.error("Connection error:", error);
    process.exit(1);
  }
}

run();
