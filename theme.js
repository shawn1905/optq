// Apply the saved theme before styles paint; theme changes never reload page data.
window.MqdqTheme = (() => {
  const storageKey = 'optq.v3.theme';
  const root = document.documentElement;
  const colors = new Map();
  const valid = value => value === 'light' || value === 'dark';
  let theme = 'dark';

  function savedTheme() {
    try { return localStorage.getItem(storageKey); } catch { return null; }
  }

  function updateButtons() {
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      const action = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
      button.setAttribute('aria-label', action);
      button.setAttribute('title', action);
      button.querySelector('.theme-toggle-label').textContent = theme === 'dark' ? '深色' : '浅色';
    });
  }

  function set(next, persist = true) {
    if (!valid(next)) return;
    const changed = next !== theme;
    theme = next;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    colors.clear();
    if (persist) {
      try { localStorage.setItem(storageKey, theme); } catch { /* Private mode still permits switching. */ }
    }
    updateButtons();
    if (changed) window.dispatchEvent(new CustomEvent('mqdq:themechange', { detail: { theme } }));
  }

  function color(name, fallback = '') {
    const property = name.startsWith('--') ? name : `--${name}`;
    if (!colors.has(property)) colors.set(property, getComputedStyle(root).getPropertyValue(property).trim());
    return colors.get(property) || fallback;
  }

  const initial = savedTheme();
  set(valid(initial) ? initial : 'dark', false);
  document.addEventListener('DOMContentLoaded', () => {
    updateButtons();
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      button.addEventListener('click', () => set(theme === 'dark' ? 'light' : 'dark'));
    });
  }, { once: true });
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) set(valid(event.newValue) ? event.newValue : 'dark', false);
  });
  window.addEventListener('pageshow', () => {
    const saved = savedTheme();
    if (valid(saved) && saved !== theme) set(saved, false);
  });
  return { get: () => theme, set, color };
})();
