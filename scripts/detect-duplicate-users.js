/**
 * detect-duplicate-users.js
 *
 * Detects duplicate users (same companyId + phoneNumber) in the database.
 * Reports groups with more than one user and shows related data counts.
 *
 * Usage:
 *   node scripts/detect-duplicate-users.js
 *   node scripts/detect-duplicate-users.js --json
 */

const mongoose = require("mongoose");
const User = require("../src/models/user.model");
const Booking = require("../src/models/booking.model");

require("dotenv").config();

async function run() {
  const asJson = process.argv.includes("--json");

  try {
    await mongoose.connect(process.env.MONGO_URI);
    if (!asJson) console.log("Connected to DB.\n");

    // Aggregate users grouped by companyId + phoneNumber
    const duplicates = await User.aggregate([
      // Only consider users with a non-empty phoneNumber
      { $match: { phoneNumber: { $exists: true, $ne: "" } } },
      {
        $group: {
          _id: {
            companyId: "$companyId",
            phoneNumber: "$phoneNumber",
          },
          count: { $sum: 1 },
          userIds: { $push: "$_id" },
          names: { $push: "$name" },
          whatsappIds: { $push: "$whatsappId" },
          createdAts: { $push: "$createdAt" },
          penalties: { $push: "$penalties" },
          fixedTurnsCounts: {
            $push: { $size: { $ifNull: ["$fixedTurns", []] } },
          },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ]);

    if (duplicates.length === 0) {
      if (asJson) {
        console.log(JSON.stringify({ duplicates: [], total: 0 }, null, 2));
      } else {
        console.log("No duplicate users found.");
      }
      await mongoose.disconnect();
      return;
    }

    // For each duplicate group, count bookings per user
    const report = [];
    for (const group of duplicates) {
      const groupInfo = {
        companyId: group._id.companyId,
        phoneNumber: group._id.phoneNumber,
        duplicateCount: group.count,
        users: [],
      };

      for (let i = 0; i < group.userIds.length; i++) {
        const userId = group.userIds[i];
        const bookingCount = await Booking.countDocuments({
          companyId: group._id.companyId,
          clientWhatsappId: group.whatsappIds[i],
        });

        groupInfo.users.push({
          userId: userId.toString(),
          name: group.names[i],
          whatsappId: group.whatsappIds[i],
          createdAt: group.createdAts[i],
          penalties: group.penalties[i],
          fixedTurnsCount: group.fixedTurnsCounts[i],
          bookingCount,
        });
      }

      report.push(groupInfo);
    }

    if (asJson) {
      console.log(JSON.stringify({ duplicates: report, total: report.length }, null, 2));
    } else {
      console.log(`Found ${report.length} duplicate group(s):\n`);
      for (const group of report) {
        console.log(`--- Phone: ${group.phoneNumber} | Company: ${group.companyId} ---`);
        console.log(`    Duplicates: ${group.duplicateCount}`);
        for (const u of group.users) {
          console.log(
            `    - ${u.name} | userId: ${u.userId} | whatsappId: ${u.whatsappId}`,
          );
          console.log(
            `      Created: ${u.createdAt} | Penalties: ${u.penalties} | FixedTurns: ${u.fixedTurnsCount} | Bookings: ${u.bookingCount}`,
          );
        }
        console.log();
      }
    }

    await mongoose.disconnect();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

run();
