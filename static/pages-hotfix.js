(() => {
  function enforcePagesOnlyControls() {
    const build = document.querySelector('#buildIndexBtn');
    if (build) {
      build.disabled = true;
      build.textContent = '由 GitHub Actions 自動更新';
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
