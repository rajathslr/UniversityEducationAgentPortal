'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluateLine, reconcileInvoice, STATUS } = require('../src/reconciliation');

const cleanAgent = { marn: null, coi_signed: false };
const dualUnsigned = { marn: 'MARN-1793021', coi_signed: false };
const dualSigned = { marn: 'MARN-1793021', coi_signed: true };

function line(over) {
  return Object.assign(
    {
      rule_type: 'percent',
      rate_percent: 15,
      tuition_amount: 20000,
      flat_amount: null,
      onshore_transfer: false,
      accepted_on_or_before_2026_03_31: false,
      exception_flag: null,
    },
    over
  );
}

test('plain onshore-eligible line is payable', () => {
  const r = evaluateLine(line(), cleanAgent);
  assert.strictEqual(r.status, STATUS.PAYABLE);
  assert.strictEqual(r.amount, 3000); // 15% of 20000
});

test('ONSHORE BLOCK: onshore transfer not grandfathered is blocked', () => {
  const r = evaluateLine(
    line({ onshore_transfer: true, accepted_on_or_before_2026_03_31: false }),
    cleanAgent
  );
  assert.strictEqual(r.status, STATUS.BLOCKED_ONSHORE);
  assert.strictEqual(r.payable, false);
});

test('GRANDFATHERING: onshore transfer accepted on/before 31 Mar 2026 stays payable', () => {
  const r = evaluateLine(
    line({ onshore_transfer: true, accepted_on_or_before_2026_03_31: true }),
    cleanAgent
  );
  assert.strictEqual(r.status, STATUS.PAYABLE);
  assert.strictEqual(r.amount, 3000);
});

test('COI FREEZE: dual agent with unsigned COI is frozen', () => {
  const r = evaluateLine(line(), dualUnsigned);
  assert.strictEqual(r.status, STATUS.FROZEN_COI);
  assert.strictEqual(r.payable, false);
});

test('COI FREEZE precedes onshore block (agent-level hold wins)', () => {
  const r = evaluateLine(
    line({ onshore_transfer: true, accepted_on_or_before_2026_03_31: false }),
    dualUnsigned
  );
  assert.strictEqual(r.status, STATUS.FROZEN_COI);
});

test('signed COI unfreezes the dual agent', () => {
  const r = evaluateLine(line(), dualSigned);
  assert.strictEqual(r.status, STATUS.PAYABLE);
});

test('exception flag => not-due', () => {
  const r = evaluateLine(line({ exception_flag: 'pre-census' }), cleanAgent);
  assert.strictEqual(r.status, STATUS.NOT_DUE);
});

test('flat rule pays flat amount', () => {
  const r = evaluateLine(
    line({ rule_type: 'flat', flat_amount: 1250 }),
    cleanAgent
  );
  assert.strictEqual(r.amount, 1250);
});

test('seed-shaped invoice yields 2 payable / 1 blocked / 1 frozen / 1 not-due', () => {
  const lines = [
    line({ marn: null, coi_signed: false }), // payable
    line({ marn: null, coi_signed: false, rule_type: 'flat', flat_amount: 1500 }), // payable
    line({ marn: null, coi_signed: false, onshore_transfer: true, accepted_on_or_before_2026_03_31: false }), // blocked
    line({ marn: 'MARN-1793021', coi_signed: false }), // frozen
    line({ marn: null, coi_signed: false, exception_flag: 'pre-census' }), // not-due
  ];
  const { totals } = reconcileInvoice(lines);
  assert.strictEqual(totals.payable, 2);
  assert.strictEqual(totals.blocked_onshore, 1);
  assert.strictEqual(totals.frozen_coi, 1);
  assert.strictEqual(totals.not_due, 1);
});
