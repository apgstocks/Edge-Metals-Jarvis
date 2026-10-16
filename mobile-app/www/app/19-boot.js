// mobile-app/www/app/19-boot.js — split from mobile-app/www/index.html's <script> (helpers/sourceParts.js reconstructs the original)
(async function boot() {
  const token = getToken();
  if (!token) { showLoginScreen(); return; }
  try {
    const me = await api('/api/me');
    ROLE = me.role || 'user';
    IS_SUPER = me.super === true;
    await bootLoads();
  } catch (err) {
    showLoginScreen();
  }
})();
