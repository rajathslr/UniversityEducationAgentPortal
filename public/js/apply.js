'use strict';
// Public "apply to partner" form. No session — this page is reachable by
// anyone, so it only ever posts to /api/apply, which stages the submission
// for admin review rather than creating an agency directly.

const errBox = document.getElementById('err');
const submitBtn = document.getElementById('submitBtn');

function showErr(msg) {
  errBox.textContent = msg;
  errBox.style.display = 'block';
  errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function val(id) { return document.getElementById(id).value.trim(); }

async function submitApplication() {
  errBox.style.display = 'none';

  // Mirror the server's rules so the common mistakes are caught before a round trip.
  const businessName = val('business_name');
  const abn = val('abn');
  const operatorName = val('operator_name');
  const operatorEmail = val('operator_email');
  if (!businessName) return showErr('Please enter your agency name.');
  if (!/^\d{11}$/.test(abn.replace(/\s+/g, ''))) return showErr('Please enter your 11-digit ABN.');
  if (!operatorName) return showErr('Please enter a primary contact name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(operatorEmail)) return showErr('Please enter a valid contact email.');

  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting…';
  try {
    await postJSON('/api/apply', {
      business_name: businessName,
      abn,
      operator_name: operatorName,
      operator_email: operatorEmail,
      origin_city: val('origin_city'),
      source_market: val('source_market'),
      marn: val('marn'),
      note: val('note'),
    });
    document.getElementById('applyForm').classList.add('hide');
    document.getElementById('applyDone').classList.add('show');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    showErr(e.message || 'Could not submit your application. Please try again.');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit application';
  }
}

submitBtn.addEventListener('click', submitApplication);
// Enter anywhere in the form submits, matching normal form behaviour.
document.getElementById('applyForm').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submitApplication(); }
});
