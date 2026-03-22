const mongoose = require("mongoose");
const User = require("./src/models/user.model");
const Booking = require("./src/models/booking.model");
require("dotenv").config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const users = await User.find({"fixedTurns.dayOfWeek": 0}).populate("fixedTurns.timeSlot").populate("fixedTurns.court");
  console.log("Users with Sunday (0) fixed turns:", JSON.stringify(users, null, 2));

  const users2 = await User.find({"fixedTurns": {$ne: []}});
  console.log("Users with ANY fixed turns:", JSON.stringify(users2, null, 2));

  mongoose.disconnect();
}
run();
