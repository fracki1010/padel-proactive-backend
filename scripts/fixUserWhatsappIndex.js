#!/usr/bin/env node
'use strict';

// Makes the (companyId, whatsappId) unique index PARTIAL so clients without a
// WhatsApp id (loaded manually, or a phone the worker could not resolve) no
// longer collide. Without the partial filter, a second client without a
// whatsappId hit E11000 and the "guardar cliente" action failed.
//
// Idempotent: drops the old index when present and ensures the partial one.
//
// Usage:
//   npm run migrate:user-whatsapp-index

const run = async () => {
  require('dotenv').config();
  const mongoose = require('mongoose');
  const connectDB = require('../src/config/database');

  await connectDB();
  const collection = mongoose.connection.collection('users');

  const existing = await collection.indexes().catch(() => []);
  const oldIndex = existing.find(
    (idx) =>
      idx.name === 'companyId_1_whatsappId_1' &&
      !idx.partialFilterExpression,
  );

  if (oldIndex) {
    await collection.dropIndex('companyId_1_whatsappId_1');
    console.log('[userWhatsappIndex] índice viejo eliminado');
  } else {
    console.log('[userWhatsappIndex] índice viejo no encontrado (ok)');
  }

  await collection.createIndex(
    { companyId: 1, whatsappId: 1 },
    {
      unique: true,
      partialFilterExpression: { whatsappId: { $type: 'string' } },
      name: 'companyId_1_whatsappId_1',
    },
  );
  console.log('[userWhatsappIndex] índice parcial asegurado');

  await mongoose.disconnect().catch(() => {});
  process.exit(0);
};

run().catch((error) => {
  console.error('[userWhatsappIndex] error:', error?.message || error);
  process.exit(1);
});
