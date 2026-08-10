'use strict';
// Login controller. If already signed in, bounce to the role's home.

(async function () {
  try {
    const { user } = await getJSON('/api/auth/me');
    if (user) { location.replace(homeFor(user.role)); return; }
  } catch (e) { /* not signed in — stay on the login page */ }
})();

const form = document.getElementById('loginForm');
const err = document.getElementById('err');
const btn = document.getElementById('submitBtn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.classList.remove('show');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const { user } = await postJSON('/api/auth/login', { username, password });
    location.replace(homeFor(user.role));
  } catch (e2) {
    err.textContent = e2.message || 'Sign in failed.';
    err.classList.add('show');
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});
