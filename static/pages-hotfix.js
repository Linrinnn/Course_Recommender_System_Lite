(() => {
  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  function enforcePagesOnlyControls() {
    const build = document.querySelector('#buildIndexBtn');
    if (build) {
      build.disabled = true;
      setText(build, '由 GitHub Actions 自動更新');
    }

    const studyLevel = document.querySelector('#studyLevelSelect');
    if (studyLevel) {
      const useful = [...studyLevel.options].some((option) => option.value && option.value !== 'unknown');
      const field = studyLevel.closest('label');
      if (field) field.hidden = !useful;
    }

    const departmentSelect = document.querySelector('#departmentSelect');
    const departmentLabel = departmentSelect?.closest('label')?.querySelector('span');
    setText(departmentLabel, '系所代碼');

    const scheduleButton = document.querySelector('#openScheduleBtn');
    if (scheduleButton && !scheduleButton.firstChild?.textContent?.includes('查看課表')) {
      const count = document.querySelector('#scheduleCount')?.textContent || '0';
      scheduleButton.innerHTML = `查看課表 <span id="scheduleCount">${count}</span>`;
    }

    const refreshButton = document.querySelector('#refreshBtn');
    setText(refreshButton, '重新載入資料');
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Run a few bounded passes because app.js populates facets asynchronously.
    // Do not observe our own DOM writes: doing so creates a self-triggering
    // MutationObserver loop that can hang Chromium with RESULT_CODE_HUNG.
    enforcePagesOnlyControls();
    setTimeout(enforcePagesOnlyControls, 500);
    setTimeout(enforcePagesOnlyControls, 1500);
  });
})();
