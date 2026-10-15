#!/usr/bin/env node
'use strict';

// Removes QA/automation artefacts from the client list. The defensive WhatsApp
// test suite creates users tagged with a `qa-*` whatsappId (e.g.
// "qa-suite:...", "qa-defensive-server:...") and junk phone numbers. They show
// up in the Socios list as fake clients.
//
// Deletes: matching Users + any ClientAccount linked to them.
// Safe: real clients never carry the `qa-` prefix.
//
// Usage:
//   npm run cleanup:qa-users
//   npm run cleanup:qa-users -- --dry-run

const { isQaUser } = require('../src/utils/phoneMatch');

const parseArgs = (argv = process.argv.slice(2)) => ({
  dryRun: argv.includes('--dry-run'),
});

const run = async () => {
  require('dotenv').config();
  const mongoose = require('mongoose');
  const connectDB = require('../src/config/database');
  const User = require('../src/models/user.model');
  const ClientAccount = require('../src/models/clientAccount.model');

  const { dryRun } = parseArgs();
  await connectDB();
  console.log(`[cleanupQaUsers] mongo conectado${dryRun ? ' (dry-run)' : ''}`);

  const candidates = await User.find(
    {},
    { _id: 1, name: 1, whatsappId: 1, companyId: 1 },
  ).lean();
  const qaUsers = candidates.filter(isQaUser);

  console.log(
    `[cleanupQaUsers] usuarios totales=${candidates.length} qa=${qaUsers.length}`,
  );

  if (qaUsers.length === 0) {
    console.log('[cleanupQaUsers] nada para limpiar');
    await mongoose.disconnect().catch(() => {});
    return;
  }

  const ids = qaUsers.map((u) => u._id);
  const linkedAccounts = await ClientAccount.find(
    { linkedUserId: { $in: ids } },
    { _id: 1 },
  ).lean();

  // A few real users can hold a qa- prefix for historical reasons; show samples.
  console.log(
    '[cleanupQaUsers] muestra:',
    qaUsers.slice(0, 5).map((u) => `${u.name || '?'} <${u.whatsappId}>`).join(' | '),
  );

  if (!dryRun) {
    const delAccounts = await ClientAccount.deleteMany({ linkedUserId: { $in: ids } });
    const delUsers = await User.deleteMany({ _id: { $in: ids } });
    console.log(
      `[cleanupQaUsers] borrados: users=${delUsers.deletedCount} clientAccounts=${delAccounts.deletedCount}`,
    );
  } else {
    console.log(
      `[cleanupQaUsers] (dry-run) borraría users=${ids.length} clientAccounts=${linkedAccounts.length}`,
    );
  }

  await mongoose.disconnect().catch(() => {});
  process.exit(0);
};

run().catch((error) => {
  console.error('[cleanupQaUsers] error:', error?.message || error);
  process.exit(1);
});
