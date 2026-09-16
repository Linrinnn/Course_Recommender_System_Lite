(() => {
  const upstreamFetch = window.fetch.bind(window);

  function asUrl(input) {
    if (input instanceof URL) return new URL(input.href);
    if (typeof input === 'string') return new URL(input, location.href);
    if (input?.url) return new URL(input.url, location.href);
    return new URL(String(input ?? ''), location.href);
  }

  window.fetch = async (input, init) => {
    const url = asUrl(input);
    const path = url.pathname.match(/\/api\/.*$/)?.[0] || '';

    // pages-api.js treats Number(null) as 0. Explicit NaN keeps an
    // unselected credit range from becoming an accidental 0-credit filter.
    if (path === '/api/courses') {
      if (!url.searchParams.has('min_credits')) url.searchParams.set('min_credits', 'NaN');
      if (!url.searchParams.has('max_credits')) url.searchParams.set('max_credits', 'NaN');
      return upstreamFetch(url, init);
    }

    return upstreamFetch(input, init);
  };

  function enforcePagesOnlyControls() {
    const build = document.querySelector('#buildIndexBtn');
    if (build) {
      if (!build.disabled) build.disabled = true;
      if (build.textContent !== '由 GitHub Actions 自動更新') {
        build.textContent = '由 GitHub Actions 自動更新';
      }
    }

    const studyLevel = document.querySelector('#studyLevelSelect');
    if (studyLevel) {
      const useful = [...studyLevel.options].some((option) => option.value && option.value !== 'unknown');
      const field = studyLevel.closest('label');
      if (field) field.hidden = !useful;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    enforcePagesOnlyControls();
    const root = document.querySelector('#buildIndexBtn')?.parentElement;
    if (root) {
      new MutationObserver(enforcePagesOnlyControls).observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    }
    setTimeout(enforcePagesOnlyControls, 500);
    setTimeout(enforcePagesOnlyControls, 1500);
  });
})();
