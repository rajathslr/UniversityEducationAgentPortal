'use strict';
/**
 * Reconciliation engine — PURE functions, no DB, no framework.
 * The frontend never re-implements this; it only renders what these return.
 *
 * A commission line resolves to exactly one status. Precedence (highest first):
 *
 *   1. frozen-coi     Agent has a MARN on file but no signed COI declaration.
 *                     The whole agent is frozen; commission is HELD (not lost).
 *   2. blocked-onshore Regulatory hard-stop. Non-payable when it is an onshore
 *                     transfer AND it was NOT accepted on/before 31 Mar 2026.
 *                     (Grandfathering: onshore + accepted on/before that date is
 *                     still payable — that is why these are two separate inputs.)
 *   3. not-due        Exception flag (withdrawn / deferred / pre-census): no
 *                     commission has accrued.
 *   4. payable        Everything cleared; the computed amount is owed.
 *
 * COI is placed first deliberately: a frozen agent is held regardless of the
 * individual line's merits, because we cannot trust an unresolved conflict of
 * interest. Onshore block is next as a compliance hard-stop.
 */

const STATUS = {
  PAYABLE: 'payable',
  BLOCKED_ONSHORE: 'blocked-onshore',
  FROZEN_COI: 'frozen-coi',
  NOT_DUE: 'not-due',
};

/**
 * @param {object} line  commission line fields
 * @param {object} agent { marn, coi_signed }
 * @returns {{status:string, amount:number, payable:boolean, reason:string}}
 */
function evaluateLine(line, agent) {
  const gross = grossAmount(line);

  // 1. COI FREEZE — MARN on file and no signed COI => held.
  if (agent && agent.marn && !agent.coi_signed) {
    return {
      status: STATUS.FROZEN_COI,
      amount: 0,
      payable: false,
      reason:
        'Agent has a migration agent number (MARN ' +
        agent.marn +
        ') but has not signed the conflict-of-interest form — students on hold, commission held.',
    };
  }

  // 2. ONSHORE BLOCK — onshore transfer not grandfathered.
  if (line.onshore_transfer === true &&
      line.accepted_on_or_before_2026_03_31 === false) {
    return {
      status: STATUS.BLOCKED_ONSHORE,
      amount: 0,
      payable: false,
      reason:
        'Student transfer within Australia accepted after 31 Mar 2026 — cannot be paid under the transfer rule.',
    };
  }

  // 3. NOT DUE — exception flag.
  if (line.exception_flag) {
    return {
      status: STATUS.NOT_DUE,
      amount: 0,
      payable: false,
      reason: 'Nothing owed — student status: ' + line.exception_flag + '.',
    };
  }

  // 4. PAYABLE.
  return {
    status: STATUS.PAYABLE,
    amount: gross,
    payable: true,
    reason: 'Cleared — ready to pay.',
  };
}

/** Gross commission for a line before rule adjudication. */
function grossAmount(line) {
  if (line.rule_type === 'flat') {
    return round2(Number(line.flat_amount) || 0);
  }
  const pct = Number(line.rate_percent) || 0;
  const base = Number(line.tuition_amount) || 0;
  return round2((base * pct) / 100);
}

/**
 * Reconcile a whole invoice.
 * @param {Array} lines  each line merged with its agent context (marn, coi_signed)
 * @returns {{lines:Array, totals:object}}
 */
function reconcileInvoice(lines) {
  const evaluated = lines.map((l) => {
    const result = evaluateLine(l, {
      marn: l.marn,
      coi_signed: l.coi_signed,
    });
    return Object.assign({}, l, {
      gross: grossAmount(l),
      status: result.status,
      payable_amount: result.amount,
      payable: result.payable,
      reason: result.reason,
    });
  });

  const totals = {
    count: evaluated.length,
    payable: count(evaluated, STATUS.PAYABLE),
    blocked_onshore: count(evaluated, STATUS.BLOCKED_ONSHORE),
    frozen_coi: count(evaluated, STATUS.FROZEN_COI),
    not_due: count(evaluated, STATUS.NOT_DUE),
    total_payable_amount: round2(
      evaluated.reduce((s, e) => s + (e.payable ? e.payable_amount : 0), 0)
    ),
    total_gross_amount: round2(evaluated.reduce((s, e) => s + e.gross, 0)),
    total_held_amount: round2(
      evaluated
        .filter((e) => e.status === STATUS.FROZEN_COI)
        .reduce((s, e) => s + e.gross, 0)
    ),
  };

  return { lines: evaluated, totals };
}

function count(arr, status) {
  return arr.filter((e) => e.status === status).length;
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

module.exports = { STATUS, evaluateLine, grossAmount, reconcileInvoice };
