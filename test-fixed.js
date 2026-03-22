const mongoose = require("mongoose");
const Booking = require("./src/models/booking.model");
const User = require("./src/models/user.model");
const TimeSlot = require("./src/models/timeSlot.model");
const Court = require("./src/models/court.model");
require("dotenv").config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const searchDate = new Date("2026-03-17T00:00:00.000Z"); // Let's check Tuesday since user has a fixed turn on 2 (Tuesday)
  const dayOfWeek = searchDate.getUTCDay();

  console.log("Day of week:", dayOfWeek);

  const query = { date: searchDate };
  const bookings = await Booking.find(query)
    .populate("timeSlot")
    .populate("court");

  const usersWithFixedTurns = await User.find({
    "fixedTurns.dayOfWeek": dayOfWeek,
  })
    .populate("fixedTurns.timeSlot")
    .populate("fixedTurns.court");

  console.log("Users with fixed turns:", usersWithFixedTurns.length);

  usersWithFixedTurns.forEach((user) => {
    user.fixedTurns.forEach((ft) => {
      if (ft.dayOfWeek === dayOfWeek) {
        console.log(
          "Found fixed turn for user:",
          user.name,
          "court:",
          ft.court?.name,
          "timeSlot:",
          ft.timeSlot?.startTime,
        );

        const hasRealBooking = bookings.some(
          (b) =>
            b.court?._id?.toString() === ft.court?._id?.toString() &&
            b.timeSlot?._id?.toString() === ft.timeSlot?._id?.toString() &&
            b.status !== "cancelado",
        );

        console.log("Has real booking?", hasRealBooking);

        if (!hasRealBooking) {
          bookings.push({
            _id: `fixed-${user._id}-${ft.court?._id}-${ft.timeSlot?._id}`,
            court: ft.court,
            timeSlot: ft.timeSlot,
            date: searchDate,
            clientName: user.name,
            clientPhone: user.phoneNumber,
            status: "confirmado",
            paymentStatus: "pendiente",
            isFixed: true,
            finalPrice: ft.timeSlot?.price || 0,
          });
        }
      }
    });
  });

  console.log("Bookings length:", bookings.length);
  // simulate res.json
  const jsonOutput = JSON.stringify(bookings);
  const parsed = JSON.parse(jsonOutput);
  const fixed = parsed.find((b) => b.isFixed);
  console.log(
    "Virtual booking format in JSON:",
    JSON.stringify(fixed, null, 2),
  );

  mongoose.disconnect();
}
run();
