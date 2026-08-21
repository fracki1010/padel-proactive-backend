/**
 * merge-duplicate-users.js
 *
 * Merges duplicate users (same companyId + phoneNumber) in the database.
 *
 * Strategy per group:
 *   - Keep the user with the most bookings (tie-break: most recent createdAt).
 *   - Reassign bookings from losers to winner (change clientWhatsappId).
 *   - Merge fixedTurns from losers into winner (skip duplicates by court+timeSlot+dayOfWeek).
 *   - Penalties: keep the maximum value among duplicates.
 *   - Update ClientAccount.linkedUserId pointing to losers → winner.
 *   - Delete loser users.
 *
 * Usage:
 *   node scripts/merge-duplicate-users.js            # dry-run (no changes)
 *   node scripts/merge-duplicate-users.js --execute   # apply changes
 */

const mongoose = require("mongoose");
const User = require("../src/models/user.model");
const Booking = require("../src/models/booking.model");
const ClientAccount = require("../src/models/clientAccount.model");

require("dotenv").config();

const DRY_RUN = !process.argv.includes("--execute");

function fixedTurnKey(ft) {
  return `${ft.court}|${ft.dayOfWeek}|${ft.timeSlot}`;
}

async function mergeGroup(group) {
  const { companyId, phoneNumber } = group._id;
  const userIds = group.userIds;

  // Fetch full user documents
  const users = await User.find({ _id: { $in: userIds } });

  // Count bookings per user to decide the winner
  const usersWithCounts = await Promise.all(
    users.map(async (u) => {
      const bookingCount = await Booking.countDocuments({
        companyId,
        clientWhatsappId: u.whatsappId,
      });
      return { user: u, bookingCount };
    }),
  );

  // Sort: most bookings first, then most recent createdAt
  usersWithCounts.sort((a, b) => {
    if (b.bookingCount !== a.bookingCount) return b.bookingCount - a.bookingCount;
    return new Date(b.user.createdAt) - new Date(a.user.createdAt);
  });

  const winner = usersWithCounts[0];
  const losers = usersWithCounts.slice(1);

  const log = [];
  log.push(`  Winner: ${winner.user.name} (${winner.user._id}) — ${winner.bookingCount} bookings`);
  for (const l of losers) {
    log.push(`  Loser:  ${l.user.name} (${l.user._id}) — ${l.bookingCount} bookings`);
  }

  if (DRY_RUN) {
    return { dryRun: true, log, winnerId: winner.user._id, loserIds: losers.map((l) => l.user._id) };
  }

  // --- APPLY CHANGES ---

  // 1. Reassign bookings from losers to winner
  for (const l of losers) {
    const result = await Booking.updateMany(
      { companyId, clientWhatsappId: l.user.whatsappId },
      { $set: { clientWhatsappId: winner.user.whatsappId } },
    );
    log.push(`  Reassigned ${result.modifiedCount} bookings from ${l.user.name} → ${winner.user.name}`);
  }

  // 2. Merge fixedTurns from losers into winner
  const existingKeys = new Set(winner.user.fixedTurns.map(fixedTurnKey));
  const newFixedTurns = [];

  for (const l of losers) {
    for (const ft of l.user.fixedTurns || []) {
      const key = fixedTurnKey(ft);
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        newFixedTurns.push(ft);
      } else {
        log.push(`  Skipped duplicate fixedTurn: court=${ft.court}, day=${ft.dayOfWeek}, slot=${ft.timeSlot} from ${l.user.name}`);
      }
    }
  }

  if (newFixedTurns.length > 0) {
    winner.user.fixedTurns.push(...newFixedTurns);
    log.push(`  Added ${newFixedTurns.length} new fixedTurns to ${winner.user.name}`);
  }

  // 3. Merge penalties: keep the maximum
  const maxPenalties = Math.max(
    winner.user.penalties || 0,
    ...losers.map((l) => l.user.penalties || 0),
  );
  if (maxPenalties !== (winner.user.penalties || 0)) {
    log.push(`  Penalties: ${winner.user.penalties || 0} → ${maxPenalties}`);
    winner.user.penalties = maxPenalties;
  }

  // 4. Save winner
  await winner.user.save();
  log.push(`  Saved winner ${winner.user.name}`);

  // 5. Update ClientAccount.linkedUserId pointing to losers → winner
  for (const l of losers) {
    const result = await ClientAccount.updateMany(
      { companyId, linkedUserId: l.user._id },
      { $set: { linkedUserId: winner.user._id } },
    );
    if (result.modifiedCount > 0) {
      log.push(`  Updated ${result.modifiedCount} ClientAccount(s) linkedUserId: ${l.user.name} → ${winner.user.name}`);
    }
  }

  // 6. Delete loser users
  for (const l of losers) {
    await User.deleteOne({ _id: l.user._id });
    log.push(`  Deleted loser ${l.user.name} (${l.user._id})`);
  }

  return { dryRun: false, log, winnerId: winner.user._id, loserIds: losers.map((l) => l.user._id) };
}

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log(`Connected to DB. Mode: ${DRY_RUN ? "DRY-RUN (no changes)" : "EXECUTE (changes will be applied)"}\n`);

    // Find duplicate groups
    const duplicates = await User.aggregate([
      { $match: { phoneNumber: { $exists: true, $ne: "" } } },
      {
        $group: {
          _id: {
            companyId: "$companyId",
            phoneNumber: "$phoneNumber",
          },
          count: { $sum: 1 },
          userIds: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ]);

    if (duplicates.length === 0) {
      console.log("No duplicate users found. Nothing to merge.");
      await mongoose.disconnect();
      return;
    }

    console.log(`Found ${duplicates.length} duplicate group(s) to process.\n`);

    const results = [];
    for (let i = 0; i < duplicates.length; i++) {
      const group = duplicates[i];
      console.log(`[${i + 1}/${duplicates.length}] Phone: ${group._id.phoneNumber} | Company: ${group._id.companyId} (${group.count} duplicates)`);

      const result = await mergeGroup(group);
      results.push(result);

      for (const line of result.log) {
        console.log(line);
      }
      console.log();
    }

    const totalLosers = results.reduce((sum, r) => sum + r.loserIds.length, 0);
    console.log("--- Summary ---");
    console.log(`Groups processed: ${duplicates.length}`);
    console.log(`Total users to delete: ${totalLosers}`);
    console.log(`Mode: ${DRY_RUN ? "DRY-RUN — no changes were made. Re-run with --execute to apply." : "EXECUTE — all changes applied."}`);

    await mongoose.disconnect();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

run();
