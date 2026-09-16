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

    const departmentSelect = document.querySelector('#departmentSelect');
    const departmentLabel = departmentSelect?.closest('label')?.querySelector('span');
    if (departmentLabel) departmentLabel.textContent = '系所代碼';

    const scheduleButton = document.querySelector('#openScheduleBtn');
    if (scheduleButton) {
      const count = document.querySelector('#scheduleCount')?.textContent || '0';
      scheduleButton.innerHTML = `查看課表 <span id="scheduleCount">${count}</span>`;
    }

    const refreshButton = document.querySelector('#refreshBtn');
    if (refreshButton) refreshButton.textContent = '重新載入資料';
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
