'use strict';

const express = require('express');
const router = express.Router();

router.use(require('./config/courts.routes'));
router.use(require('./config/slots.routes'));
router.use(require('./config/whatsapp.routes'));
router.use(require('./config/notifications.routes'));
router.use(require('./config/botAutomation.routes'));
router.use(require('./config/penalties.routes'));
router.use(require('./config/clubClosures.routes'));
router.use(require('./config/companyImages.routes'));

module.exports = router;