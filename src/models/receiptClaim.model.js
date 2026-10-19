'use strict';

// Receipt claims: one document per unique receipt "key" (image hash and/or the
// bank operation id) per company. The UNIQUE index is the atomic guard — two
// concurrent attempts to reuse the same receipt collide and only one wins.
//
// Claims are temporary: if the booking confirmation fails afterwards the claim
// is released so the client can retry. Successful claims stay forever.

const mongoose = require('mongoose');

const receiptClaimSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    key: {
      type: String,
      required: true,
      trim: true,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
    },
  },
  { timestamps: true },
);

receiptClaimSchema.index({ companyId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('ReceiptClaim', receiptClaimSchema);
