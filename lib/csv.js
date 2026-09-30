'use strict';

function cell(v) {
  const s = v == null ? '' : String(v);
  // Guard against spreadsheet formula injection from keyword text.
  const safe = /^[=+\-@\t\r]/.test(s) && isNaN(Number(s)) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

function toCsv(header, rows) {
  return '﻿' + [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { toCsv };
