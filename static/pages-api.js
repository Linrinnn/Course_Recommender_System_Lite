(() => {
  const nativeFetch = window.fetch.bind(window);
  const DATA_URL = new URL('data/catalog.json', document.baseURI);
  const DAYTIME = new Set(['D0','D1','D2','D3','D4','DN','D5','D6','D7','D8']);
  const EVENING = new Set(['E0','E1','E2','E3','E4']);
  const ASSESSMENT_FAMILIES = {
    exam: ['1','6','7','8','9','14'],
    writing: ['2','3','10','12','18'],
    presentation: ['4','13','15'],
    practical: ['5','16','17'],
    participation: ['11'],
  };
  let datasetPromise = null;

  function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  function loadDataset() {
    if (!datasetPromise) {
      datasetPromise = nativeFetch(DATA_URL, { cache: 'no-cache' }).then(async (response) => {
        if (!response.ok) throw new Error(`靜態課程資料載入失敗：HTTP ${response.status}`);
        return response.json();
      });
    }
    return datasetPromise;
  }

  function commaSet(value, upper = false) {
    const values = new Set(String(value || '').split(',').map((v) => v.trim()).filter(Boolean));
    return upper ? new Set([...values].map((v) => v.toUpperCase())) : values;
  }

  function n(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function text(value) { return String(value ?? '').toLocaleLowerCase(); }

  function tokenScore(course, query) {
    const terms = text(query).split(/\s+/).filter(Boolean);
    if (!terms.length) return 0;
    const fields = [
      [5, `${course.name || ''} ${course.name_en || ''}`],
      [4, `${course.course_code || ''} ${course.teacher || ''} ${course.teacher_en || ''}`],
      [2.2, course.objective || ''],
      [1.6, course.weekly_progress || ''],
      [1.4, course.prerequisite || ''],
      [1.2, course.materials_text || ''],
      [1.1, (course.relations || []).map((x) => x.label || '').join(' ')],
      [1, (course.teaching_methods || []).map((x) => x.label || '').join(' ')],
      [1, (course.assessments || []).map((x) => x.label || '').join(' ')],
      [1, `${course.department_code || ''} ${course.department || ''} ${course.division || ''} ${course.class_group || ''}`],
      [0.8, (course.course_tags || []).map((x) => x.label || '').join(' ')],
    ];
    const full = text(fields.map(([, v]) => v).join(' '));
    if (!terms.every((term) => full.includes(term))) return 0;
    let score = 0;
    for (const [weight, field] of fields) {
      const normalized = text(field);
      for (const term of terms) if (normalized.includes(term)) score += weight;
    }
    return score;
  }

  function matchesWeighted(course, field, selected, criterion, minimum) {
    if (!selected.size) return true;
    const rows = course[field] || [];
    if (!rows.length) return false;
    if (criterion === 'minimum') {
      return rows.some((item) => selected.has(String(item.id)) && (n(item.percent) || 0) >= minimum);
    }
    const maximum = Math.max(...rows.map((item) => n(item.percent) || 0));
    return rows.some((item) => selected.has(String(item.id)) && (n(item.percent) || 0) === maximum);
  }

  function matchesAssessmentStyle(course, style) {
    if (style === 'all') return true;
    if (!course.detail_indexed) return false;
    const values = new Map((course.assessments || []).map((item) => [String(item.id), n(item.percent) || 0]));
    const sum = (ids) => ids.reduce((total, id) => total + (values.get(id) || 0), 0);
    if (style === 'no_exams') return sum(ASSESSMENT_FAMILIES.exam) === 0;
    const totals = Object.fromEntries(Object.entries(ASSESSMENT_FAMILIES).map(([key, ids]) => [key, sum(ids)]));
    const maximum = Math.max(0, ...Object.values(totals));
    return maximum > 0 && totals[style] === maximum;
  }

  function matchesOnline(course, mode) {
    if (mode === 'all') return true;
    const value = course.online_teaching;
    if (!value) return false;
    const sync = Boolean(value.sync), asyncMode = Boolean(value.async);
    if (mode === 'physical_only') return !sync && !asyncMode;
    if (mode === 'has_online') return sync || asyncMode;
    if (mode === 'sync') return sync;
    if (mode === 'async') return asyncMode;
    if (mode === 'both') return sync && asyncMode;
    return true;
  }

  function matchesTime(course, mode, includeUnknown) {
    const meetings = course.meetings || [];
    if (!meetings.length) return includeUnknown;
    if (mode === 'all') return true;
    const sections = new Set(meetings.flatMap((m) => m.sections || []));
    if (mode === 'daytime') return [...sections].some((s) => DAYTIME.has(s));
    if (mode === 'evening') return [...sections].some((s) => EVENING.has(s));
    if (mode === 'weekday_evening_or_saturday') {
      return meetings.some((m) => m.weekday === 6 || (m.sections || []).some((s) => EVENING.has(s)));
    }
    return true;
  }

  function sortRows(rows, sort, hasQuery) {
    const cmpText = (a, b) => String(a || '').localeCompare(String(b || ''), 'zh-Hant');
    if (sort === 'relevance' && hasQuery) {
      rows.sort((a, b) => b.score - a.score || cmpText(a.course.name, b.course.name));
      return;
    }
    rows.sort((a, b) => {
      const x = a.course, y = b.course;
      if (sort === 'department') return cmpText(x.department, y.department) || cmpText(x.name, y.name);
      if (sort === 'grade') return (x.grade ?? 99) - (y.grade ?? 99) || cmpText(x.name, y.name);
      if (sort === 'teacher') return cmpText(x.teacher, y.teacher) || cmpText(x.name, y.name);
      if (sort === 'credits') return (n(x.credits_number) ?? 999) - (n(y.credits_number) ?? 999) || cmpText(x.name, y.name);
      if (sort === 'course_code') return cmpText(x.course_code, y.course_code) || cmpText(x.name, y.name);
      return cmpText(x.name, y.name) || cmpText(x.course_code, y.course_code);
    });
  }

  function searchCourses(courses, params) {
    const q = (params.get('q') || '').trim();
    const department = text(params.get('department'));
    const division = text(params.get('division'));
    const studyLevel = params.get('study_level') || '';
    const required = text(params.get('required_elective'));
    const teacher = text(params.get('teacher'));
    const classGroup = text(params.get('class_group'));
    const room = text(params.get('room'));
    const teachingLanguage = params.get('teaching_language') || '';
    const materialLanguage = params.get('material_language') || '';
    const prerequisite = text(params.get('prerequisite'));
    const weekday = n(params.get('weekday'));
    const grade = n(params.get('grade'));
    const section = (params.get('section') || '').toUpperCase();
    const selectedSections = commaSet(params.get('sections'), true);
    const selectedTags = commaSet(params.get('course_tag'));
    const selectedMethods = commaSet(params.get('teaching_method'));
    const selectedAssessments = commaSet(params.get('assessment'));
    const selectedRelations = commaSet(params.get('relation'));
    const selectedInstructors = commaSet(params.get('instructor'));
    const includeIndirect = params.get('include_indirect_relations') !== 'false';
    const timeOfDay = params.get('time_of_day') || 'all';
    const includeUnknown = params.get('include_unknown_schedule') !== 'false';
    const schedule = params.get('schedule') || 'all';
    const onlineTeaching = params.get('online_teaching') || 'all';
    const assessmentStyle = params.get('assessment_style') || 'all';
    const detailIndexed = params.get('detail_indexed') || 'all';
    const methodCriterion = params.get('teaching_method_criterion') || 'dominant';
    const assessmentCriterion = params.get('assessment_criterion') || 'dominant';
    const methodMin = n(params.get('teaching_method_min')) ?? 20;
    const assessmentMin = n(params.get('assessment_min')) ?? 20;
    const minCredits = n(params.get('min_credits'));
    const maxCredits = n(params.get('max_credits'));
    const rows = [];

    for (const course of courses) {
      const score = q ? tokenScore(course, q) : 0;
      if (q && score <= 0) continue;
      if (
        department
        && text(course.department_code) !== department
        && text(course.department) !== department
      ) continue;
      if (grade && course.grade !== grade) continue;
      if (division && text(course.division) !== division) continue;
      if (studyLevel && course.study_level !== studyLevel) continue;
      if (required && text(course.required_elective) !== required) continue;
      if (selectedTags.size && !(course.course_tags || []).some((tag) => selectedTags.has(String(tag.code)))) continue;
      if (teacher && !text(course.teacher).includes(teacher)) continue;
      if (selectedInstructors.size && !(course.instructors || []).some((item) => selectedInstructors.has(String(item.id)))) continue;
      if (classGroup && !text(course.class_group).includes(classGroup)) continue;
      const meetings = course.meetings || [];
      if (room && !meetings.some((m) => text(m.room) === room)) continue;
      if (weekday && !meetings.some((m) => m.weekday === weekday)) continue;
      if (section && !meetings.some((m) => (m.sections || []).includes(section))) continue;
      if (selectedSections.size) {
        const actual = new Set(meetings.flatMap((m) => m.sections || []));
        if (![...selectedSections].some((s) => actual.has(s))) continue;
      }
      if (!matchesTime(course, timeOfDay, includeUnknown)) continue;
      if (schedule === 'known' && !meetings.length) continue;
      if (schedule === 'unknown' && meetings.length) continue;
      const credits = n(course.credits_number);
      if (minCredits !== null && (credits === null || credits < minCredits)) continue;
      if (maxCredits !== null && (credits === null || credits > maxCredits)) continue;
      if (teachingLanguage && course.teaching_language !== teachingLanguage) continue;
      if (materialLanguage && course.material_language !== materialLanguage) continue;
      if (!matchesWeighted(course, 'teaching_methods', selectedMethods, methodCriterion, methodMin)) continue;
      if (!matchesWeighted(course, 'assessments', selectedAssessments, assessmentCriterion, assessmentMin)) continue;
      if (!matchesAssessmentStyle(course, assessmentStyle)) continue;
      if (!matchesOnline(course, onlineTeaching)) continue;
      if (selectedRelations.size) {
        const actual = new Set((course.relations || []).filter((item) => includeIndirect || item.strength === 'direct').map((item) => String(item.id)));
        if (![...selectedRelations].some((id) => actual.has(id))) continue;
      }
      if (prerequisite && !text(course.prerequisite).includes(prerequisite)) continue;
      if (detailIndexed === 'yes' && !course.detail_indexed) continue;
      if (detailIndexed === 'no' && course.detail_indexed) continue;
      rows.push({ score, course });
    }

    const sort = params.get('sort') || 'relevance';
    sortRows(rows, sort, Boolean(q));
    const pageSize = Math.max(1, Math.min(100, n(params.get('page_size')) || 25));
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const requestedPage = Math.max(1, n(params.get('page')) || 1);
    const page = Math.min(requestedPage, totalPages);
    const start = (page - 1) * pageSize;
    const items = rows.slice(start, start + pageSize).map(({ score, course }) => q ? { ...course, search_score: Math.round(score * 1000) / 1000 } : course);
    return { items, total, page, page_size: pageSize, total_pages: totalPages };
  }

  function apiPath(url) {
    const match = url.pathname.match(/\/api\/.*$/);
    return match ? match[0] : null;
  }

  window.fetch = async (input, init) => {
    const raw = input instanceof URL ? input.href : (typeof input === 'string' ? input : input?.url);
    if (!raw) return nativeFetch(input, init);
    const url = new URL(raw, location.href);
    const path = apiPath(url);
    if (!path) return nativeFetch(input, init);

    try {
      const data = await loadDataset();
      if (path === '/api/meta') return jsonResponse(data.meta);
      if (path === '/api/facets') return jsonResponse(data.facets);
      if (path === '/api/index/status') {
        return jsonResponse({
          running: false,
          catalog_total: data.meta.course_count,
          catalog_indexed: data.meta.detail_indexed,
          complete: data.meta.detail_index_complete,
          last_error: '',
        });
      }
      if (path === '/api/index/start') {
        return jsonResponse({
          ok: false,
          detail: 'GitHub Pages 版由 GitHub Actions 更新完整索引，不需要在瀏覽器建立。',
          running: false,
          catalog_total: data.meta.course_count,
          catalog_indexed: data.meta.detail_indexed,
          complete: data.meta.detail_index_complete,
        }, 409);
      }
      if (path === '/api/refresh') {
        datasetPromise = null;
        const refreshed = await loadDataset();
        return jsonResponse({ ok: true, course_count: refreshed.meta.course_count, detail_indexed: refreshed.meta.detail_indexed });
      }
      if (path === '/api/courses') {
        const result = searchCourses(data.courses, url.searchParams);
        return jsonResponse({ ...result, academic_year: data.meta.academic_year, semester: data.meta.semester });
      }
      const detailMatch = path.match(/^\/api\/course\/([^/]+)$/);
      if (detailMatch) {
        const courseId = decodeURIComponent(detailMatch[1]);
        const course = data.courses.find((item) => String(item.id) === courseId);
        return course ? jsonResponse(course) : jsonResponse({ detail: '找不到課程' }, 404);
      }
      return jsonResponse({ detail: `Pages 模式不支援：${path}` }, 404);
    } catch (error) {
      return jsonResponse({ detail: error.message || String(error) }, 500);
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    const build = document.querySelector('#buildIndexBtn');
    if (build) {
      build.disabled = true;
      build.textContent = '由 GitHub Actions 自動更新';
    }
    const note = document.querySelector('.index-note');
    if (note) note.textContent = '此為 GitHub Pages 版。課程索引由 GitHub Actions 自動產生，不需要在本機啟動 Python。';
  });
})();
