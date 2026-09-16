(() => {
  const upstreamFetch = window.fetch.bind(window);
  const catalogUrl = new URL('data/catalog.json', document.baseURI).href;

  function clean(value) {
    return String(value ?? '').trim();
  }

  function departmentCode(course) {
    let code = clean(course.department_code).toUpperCase();
    if (/^\d$/.test(code)) code = code.padStart(2, '0');
    if (/^[A-Z0-9]{2}$/.test(code)) return code;

    const courseCode = clean(course.course_code).toUpperCase();
    const dashed = courseCode.match(/^[A-Z]+-([A-Z0-9]{2})/);
    if (dashed) return dashed[1];

    // Current FJU API may return compact codes such as DAT1100009.
    // When the department code is absent, keep the department name rather
    // than guessing from a compact code with an unclear prefix layout.
    return '';
  }

  function departmentName(course) {
    return clean(course.department) || clean(course.raw_department) || '未命名系所';
  }

  function pickCanonicalName(counts) {
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0], 'zh-Hant'))[0]?.[0] || '未命名系所';
  }

  function transformCatalog(payload) {
    const courses = Array.isArray(payload?.courses) ? payload.courses : [];
    if (!courses.length) return payload;

    const namesByCode = new Map();
    for (const course of courses) {
      const code = departmentCode(course);
      if (!code) continue;
      const name = departmentName(course);
      if (!namesByCode.has(code)) namesByCode.set(code, new Map());
      const counts = namesByCode.get(code);
      counts.set(name, (counts.get(name) || 0) + 1);
    }

    const canonical = new Map(
      [...namesByCode.entries()].map(([code, counts]) => [code, pickCanonicalName(counts)])
    );
    const optionCounts = new Map();

    for (const course of courses) {
      const code = departmentCode(course);
      const originalName = departmentName(course);
      if (!code) {
        course.department_name = originalName;
        course.department = originalName;
        optionCounts.set(originalName, (optionCounts.get(originalName) || 0) + 1);
        continue;
      }

      const name = canonical.get(code) || originalName;
      const label = `${code}｜${name}`;
      course.department_name = name;
      course.department_code = code;
      course.department = label;
      optionCounts.set(label, (optionCounts.get(label) || 0) + 1);
    }

    const coded = [];
    const uncoded = [];
    for (const [label, count] of optionCounts) {
      const match = label.match(/^([A-Z0-9]{2})｜/);
      const item = { value: label, label, count };
      (match ? coded : uncoded).push(item);
    }
    coded.sort((a, b) => a.value.slice(0, 2).localeCompare(b.value.slice(0, 2), 'en', { numeric: true }));
    uncoded.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hant'));

    payload.facets = payload.facets || {};
    payload.facets.departments = [...coded, ...uncoded];
    return payload;
  }

  function inputUrl(input) {
    if (input instanceof URL) return input.href;
    if (typeof input === 'string') return new URL(input, location.href).href;
    if (input?.url) return new URL(input.url, location.href).href;
    return '';
  }

  window.fetch = async (input, init) => {
    const href = inputUrl(input);
    if (href !== catalogUrl) return upstreamFetch(input, init);

    const response = await upstreamFetch(input, init);
    if (!response.ok) return response;

    const payload = transformCatalog(await response.clone().json());
    const headers = new Headers(response.headers);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  document.addEventListener('DOMContentLoaded', () => {
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
  });
})();
