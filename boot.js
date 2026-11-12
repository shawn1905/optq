/* 本地免登录引导：提供与原站一致的全局门面（DashboardCommon / createDashboardAccess / 导航菜单）。 */
window.DashboardCommon = { readUserId: () => '' };
window.createDashboardAccess = () => ({
  show() {},
  async check({ isCurrent, onGranted }) {
    if (!isCurrent || isCurrent()) onGranted();
  },
});

(() => {
  document.body.classList.remove('access-pending', 'access-denied', 'dashboard-booting');
  const gate = document.getElementById('accessGate');
  if (gate) gate.hidden = true;

  const switcher = document.getElementById('pageSwitcher');
  if (!switcher) return;
  const menu = document.getElementById('pageMenu');
  const toggle = document.getElementById('pageMenuToggle');
  function positionMenu() {
    menu.style.left = '0px';
    const rect = menu.getBoundingClientRect(), width = document.documentElement.clientWidth;
    const shift = Math.max(12 - rect.left, Math.min(0, width - 12 - rect.right));
    menu.style.left = `${shift}px`;
  }
  function setOpen(open, restoreFocus = false) {
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) positionMenu();
    if (restoreFocus) toggle.focus();
  }
  toggle.addEventListener('click', () => setOpen(menu.hidden));
  toggle.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    setOpen(true);
    const links = menu.querySelectorAll('a:not([hidden])');
    links[event.key === 'ArrowDown' ? 0 : links.length - 1]?.focus();
  });
  menu.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const links = [...menu.querySelectorAll('a:not([hidden])')];
    const index = links.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
    links[next]?.focus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); setOpen(false, true); }
  });
  document.addEventListener('pointerdown', event => { if (!switcher.contains(event.target)) setOpen(false); });
  document.addEventListener('focusin', event => { if (!switcher.contains(event.target)) setOpen(false); });
  window.addEventListener('resize', () => { if (!menu.hidden) positionMenu(); });
})();

import('./navigation.mjs').then(m => m.setupCompactNavigation?.()).catch(() => {});
