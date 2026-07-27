// Docs chrome: theme persistence, the "On this page" rail, and the mobile drawer.
// No dependencies — these pages are served as static files.

(() => {
  const root = document.documentElement;

  // --- theme ---------------------------------------------------------------
  // Applied in <head> before paint to avoid a flash; this only wires the toggle.
  const toggle = document.querySelector('.theme-toggle');
  const label = () => (root.dataset.theme === 'dark' ? 'Light' : 'Dark');
  if (toggle) {
    toggle.textContent = label();
    toggle.addEventListener('click', () => {
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem('a2w-theme', root.dataset.theme);
      } catch {
        /* private mode — the choice just will not persist */
      }
      toggle.textContent = label();
    });
  }

  // --- on this page --------------------------------------------------------
  const toc = document.querySelector('.toc');
  const headings = [...document.querySelectorAll('article h2[id], article h3[id]')];
  if (toc && headings.length) {
    const list = document.createElement('div');
    for (const h of headings) {
      const a = document.createElement('a');
      a.href = `#${h.id}`;
      a.textContent = h.dataset.toc || h.textContent.trim();
      if (h.tagName === 'H3') a.className = 'h3';
      list.append(a);
    }
    toc.append(list);

    // Highlight the heading nearest the top of the viewport.
    const links = new Map(headings.map((h, i) => [h.id, list.children[i]]));
    const seen = new Set();
    const io = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          if (e.isIntersecting) seen.add(e.target.id);
          else seen.delete(e.target.id);
        }
        const current = headings.find(h => seen.has(h.id));
        for (const a of list.children) a.classList.remove('active');
        if (current) links.get(current.id)?.classList.add('active');
      },
      { rootMargin: '-80px 0px -70% 0px' },
    );
    headings.forEach(h => io.observe(h));
  }

  // --- mobile drawer -------------------------------------------------------
  const sidebar = document.querySelector('.sidebar');
  const menu = document.querySelector('.menu-btn');
  if (sidebar && menu) {
    const setOpen = open => {
      sidebar.dataset.open = String(open);
      menu.setAttribute('aria-expanded', String(open));
    };
    menu.addEventListener('click', () => setOpen(sidebar.dataset.open !== 'true'));
    sidebar.addEventListener('click', e => {
      if (e.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', e => e.key === 'Escape' && setOpen(false));
  }
})();
