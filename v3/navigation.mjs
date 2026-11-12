// One disclosure for every shared dashboard/account header. Without JS the
// original wrapping navigation remains available as a progressive fallback.
export function setupCompactNavigation(doc = document, win = window) {
  const nav = doc.querySelector('.unified-header > .primary-navigation');
  if (!nav || nav.dataset.compactReady) return;
  nav.dataset.compactReady = 'true';
  const header = nav.parentElement;
  const compact = win.matchMedia('(max-width: 1200px)');
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'primary-navigation-toggle';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', '打开主导航');
  button.setAttribute('title', '菜单');
  nav.id ||= 'primaryNavigation';
  button.setAttribute('aria-controls', nav.id);
  button.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path class="navigation-menu-icon" d="M4 6h16M4 12h16M4 18h16"/><path class="navigation-close-icon" d="m6 6 12 12M18 6 6 18"/></svg>';
  nav.before(button);
  header.classList.add('has-compact-navigation');

  function sizePanel() {
    nav.style.setProperty('--primary-navigation-top', `${Math.max(0, header.getBoundingClientRect().bottom) + 6}px`);
  }
  function closeFeatureMenu() {
    const menu = nav.querySelector('#pageMenu');
    const toggle = nav.querySelector('#pageMenuToggle');
    if (menu) { menu.hidden = true; menu.style.left = ''; }
    toggle?.setAttribute('aria-expanded', 'false');
  }
  function setOpen(open, restoreFocus = false) {
    open = compact.matches && open;
    header.classList.toggle('navigation-open', open);
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? '关闭主导航' : '打开主导航');
    if (!open) closeFeatureMenu();
    if (open) {
      sizePanel();
      const userMenu = doc.getElementById('userMenu');
      if (userMenu) userMenu.open = false;
    }
    if (restoreFocus) button.focus();
  }
  const isOpen = () => button.getAttribute('aria-expanded') === 'true';
  button.addEventListener('click', () => setOpen(!isOpen()));
  button.addEventListener('keydown', event => {
    if (!compact.matches || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    setOpen(true);
    const items = nav.querySelectorAll(':scope > a, :scope > .page-switcher > button');
    items[event.key === 'ArrowDown' ? 0 : items.length - 1]?.focus();
  });
  header.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !isOpen()) return;
    // The feature submenu gets the first Escape; the next closes the outer nav.
    if (nav.querySelector('#pageMenu:not([hidden])')) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false, true);
  });
  nav.addEventListener('click', event => {
    if (event.target.closest('a[href]') && compact.matches) setOpen(false);
  });
  doc.addEventListener('pointerdown', event => {
    if (!nav.contains(event.target) && !button.contains(event.target) && isOpen()) setOpen(false);
  });
  doc.addEventListener('focusin', event => {
    if (!nav.contains(event.target) && event.target !== button && isOpen()) setOpen(false);
  });
  compact.addEventListener('change', () => {
    const focused = doc.activeElement;
    setOpen(false);
    if (compact.matches && nav.contains(focused)) button.focus();
    else if (!compact.matches && focused === button) nav.querySelector('a')?.focus();
  });
  win.addEventListener('pageshow', () => setOpen(false));
  win.addEventListener('resize', () => { if (isOpen()) sizePanel(); });
}

if (typeof document !== 'undefined') setupCompactNavigation();
