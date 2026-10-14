#!/usr/bin/env node
'use strict';

// Migrate GENERAL schedules (court == null) into per-court schedules.
//
// For every company:
//   1. copy each general slot into every ACTIVE court as an owned slot
//      (skipping courts that already own that startTime), then
//   2. delete the general slots.
//
// Idempotent: a second run finds no general slots and is a no-op.
//
// Usage:
//   npm run migrate:slots-per-court
//   npm run migrate:slots-per-court -- --dry-run

const { planPerCourtConversion } = require('../src/utils/slotConversionPlan');

const parseArgs = (argv = process.argv.slice(2)) => ({
  dryRun: argv.includes('--dry-run'),
});

const buildOwnedSlot = (courtId, source) => ({
  companyId: source.companyId,
  court: courtId,
  startTime: source.startTime,
  endTime: source.endTime,
  ...(Number.isInteger(source.durationMinutes)
    ? { durationMinutes: source.durationMinutes }
    : {}),
  ...(source.label ? { label: source.label } : {}),
  price: source.price,
  isActive: source.isActive !== false,
  order: source.order,
});

const run = async () => {
  require('dotenv').config();
  const mongoose = require('mongoose');
  const connectDB = require('../src/config/database');
  const TimeSlot = require('../src/models/timeSlot.model');
  const Court = require('../src/models/court.model');
  const Company = require('../src/models/company.model');

  const { dryRun } = parseArgs();

  await connectDB();
  console.log(`[perCourtSlots] mongo conectado${dryRun ? ' (dry-run)' : ''}`);

  const companies = await Company.find({}, { _id: 1, name: 1 }).lean();
  let createdTotal = 0;
  let skippedTotal = 0;
  let deletedTotal = 0;

  for (const company of companies) {
    const companyId = company._id;

    const [generalSlots, courts, ownedSlots] = await Promise.all([
      TimeSlot.find({ companyId, court: null }).lean(),
      Court.find({ companyId, isActive: true }, { _id: 1, name: 1 }).lean(),
      TimeSlot.find({ companyId, court: { $ne: null } }, { court: 1, startTime: 1 }).lean(),
    ]);

    if (generalSlots.length === 0) {
      continue;
    }

    const plan = planPerCourtConversion({ generalSlots, courts, ownedSlots });

    console.log(
      `[perCourtSlots] ${company.name || companyId}: generales=${generalSlots.length} ` +
        `canchas=${courts.length} aCrear=${plan.toCreate.length} ` +
        `omitidos=${plan.skipped} aBorrarGenerales=${plan.toDeleteIds.length}`,
    );

    if (!dryRun) {
      if (plan.toCreate.length > 0) {
        await TimeSlot.insertMany(
          plan.toCreate.map(({ court, source }) => buildOwnedSlot(court, source)),
        );
      }
      if (plan.toDeleteIds.length > 0) {
        await TimeSlot.deleteMany({ _id: { $in: plan.toDeleteIds } });
      }
    }

    createdTotal += plan.toCreate.length;
    skippedTotal += plan.skipped;
    deletedTotal += plan.toDeleteIds.length;
  }

  console.log(
    `[perCourtSlots] listo: creados=${createdTotal} omitidos=${skippedTotal} ` +
      `generalesBorrados=${deletedTotal}${dryRun ? ' (dry-run, nada escrito)' : ''}`,
  );

  await mongoose.disconnect().catch(() => {});
  process.exit(0);
};

run().catch((error) => {
  console.error('[perCourtSlots] error:', error?.message || error);
  process.exit(1);
});
