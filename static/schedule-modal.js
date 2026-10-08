(() => {
  const button = document.querySelector('#openScheduleBtn');
  if (!button) return;

  const count = button.querySelector('#scheduleCount');
  if (!button.classList.contains('rail-item') && button.firstChild?.nodeType === Node.TEXT_NODE) {
    button.firstChild.textContent = '我的課表 ';
  }
  if (count) count.setAttribute('aria-label', '目前課表課程數');

  const dialog = document.createElement('dialog');
  dialog.id = 'scheduleModal';
  dialog.className = 'schedule-modal';
  dialog.setAttribute('aria-label', '課表');
  dialog.innerHTML = `
    <div class="schedule-modal-shell">
      <header class="schedule-modal-head">
        <div>
          <strong>我的課表</strong>
          <span class="schedule-modal-hint">點選節次即可搜尋可加入的課程</span>
        </div>
        <button type="button" id="closeScheduleModalBtn" class="secondary">關閉</button>
      </header>
      <iframe id="scheduleModalFrame" class="schedule-modal-frame" title="輔大課表" loading="lazy"></iframe>
    </div>`;
  document.body.append(dialog);

  const style = document.createElement('style');
  style.textContent = `
    .schedule-modal {
      width: min(96vw, 1540px);
      height: min(94vh, 1040px);
      max-width: none;
      max-height: none;
      padding: 0;
      border: 1px solid #d7ddd7;
      border-radius: 12px;
      overflow: hidden;
      background: #fff;
      box-shadow: 0 30px 90px rgba(18, 31, 22, .23);
    }
    .schedule-modal::backdrop { background: rgba(22, 34, 26, .52); }
    .schedule-modal-shell { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .schedule-modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 19px;
      border-bottom: 1px solid #e5e9e5;
      background: #fff;
      flex: 0 0 auto;
    }
    .schedule-modal-head > div { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
    .schedule-modal-head strong { font-size: 1.05rem; font-weight: 730; }
    .schedule-modal-hint { color: #78817a; font-size: .81rem; }
    .schedule-modal-frame { width: 100%; height: 100%; flex: 1 1 auto; min-height: 0; border: 0; background: #f7f7f5; }
    @media (max-width: 720px) {
      .schedule-modal { width: 100vw; height: 100dvh; border: 0; border-radius: 0; }
      .schedule-modal-hint { display: none; }
    }
  `;
  document.head.append(style);

  const frame = dialog.querySelector('#scheduleModalFrame');
  const closeButton = dialog.querySelector('#closeScheduleModalBtn');

  function prepareEmbeddedSchedule() {
    try {
      const doc = frame.contentDocument;
      if (!doc?.head) return;
      if (doc.getElementById('embeddedScheduleStyle')) return;
      const embeddedStyle = doc.createElement('style');
      embeddedStyle.id = 'embeddedScheduleStyle';
      embeddedStyle.textContent = `
        body { background: #f7f7f5 !important; }
        .schedule-shell { max-width: none !important; padding: 14px !important; }
        .schedule-shell > .hero { display: none !important; }
        #openInSearchBtn { display: none !important; }
        .schedule-control-panel { margin-top: 0 !important; }
      `;
      doc.head.append(embeddedStyle);
    } catch {
      // Same-origin route is expected; keep the page usable even if styling injection fails.
    }
  }

  function openScheduleModal(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!frame.src) frame.src = '/schedule?embed=1';
    if (!dialog.open) dialog.showModal();
  }

  button.addEventListener('click', openScheduleModal, true);
  frame.addEventListener('load', prepareEmbeddedSchedule);
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
})();
