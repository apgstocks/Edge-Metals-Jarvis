#!/usr/bin/env node
// Prints the weekly owner report (helpers/ownerReport.js). Read-only; sends nothing.
//   node scripts/owner-report.js [--days=7]
'use strict';
require('dotenv').config();
const o = require('../helpers/ownerReport');
const a = process.argv.find((x) => x.startsWith('--days='));
console.log(o.text(o.build({ days: a ? Math.max(1, Number(a.slice(7)) || 7) : 7 })));
