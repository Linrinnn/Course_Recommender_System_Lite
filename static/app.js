const $ = (selector) => document.querySelector(selector);
const weekdays = ["", "一", "二", "三", "四", "五", "六", "日"];
const stateKey = "fju-course-liteplus:state";
const legacyKey = "fju-course-lite:selected";

let meta = null;
let facets = {};
let currentCourses = [];
let currentPage = 1;
let totalPages = 1;
let totalResults = 0;
let selectedSections = new Set();
let state = loadState();
const favoriteKey = "fju-course-liteplus:favorites-v1";
let favoriteCourses = loadLocalList(favoriteKey);
let selectedGrades = new Set();
let selectedWeekdays = new Set();
let linkedOptions = null;
let linkedSequence = 0;
let filterDebounce;
let viewMode = "all";
let avoidConflicts = new URLSearchParams(location.search).get("avoid_conflicts") === "1";
let searchSequence = 0;

function loadLocalList(key) {
  try {
    const data = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}
function persistList(key, values) {
  try { localStorage.setItem(key, JSON.stringify(values)); }
  catch { window.alert("瀏覽器儲存空間不足，無法保存這項操作。"); }
}
function snapshotCourse(course) {
  const fields = [
    "id", "course_code", "name", "name_en", "teacher", "teacher_en",
    "credits", "credits_number", "department", "department_code", "division",
    "grade", "class_group", "required_elective", "teaching_language",
    "meetings", "outline_url", "course_tags", "detail_indexed",
  ];
  return Object.fromEntries(fields.map((name) => [name, course[name] ?? null]));
}
function hasFavorite(id) { return favoriteCourses.some((course) => String(course.id) === String(id)); }
function toggleFavorite(course) {
  if (hasFavorite(course.id)) favoriteCourses = favoriteCourses.filter((item) => String(item.id) !== String(course.id));
  else favoriteCourses.unshift(snapshotCourse(course));
  persistList(favoriteKey, favoriteCourses);
  if (viewMode === "favorites") search({ updateUrl: false }); else renderCourses();
}
function blockedSlots() {
  const used = new Set();
  for (const course of selectedCourses()) for (const meeting of course.meetings || []) {
    if (!Number.isInteger(meeting.weekday) || meeting.weekday < 1 || meeting.weekday > 7) continue;
    for (const section of meeting.sections || []) used.add(`${meeting.weekday}:${String(section).toUpperCase()}`);
  }
  return used;
}
function courseOverlaps(course, blocked) {
  return (course.meetings || []).some((meeting) =>
    (meeting.sections || []).some((section) => blocked.has(`${meeting.weekday}:${String(section).toUpperCase()}`))
  );
}
function updateCourseToolsUI() {
  $("#favoriteCount").textContent = String(favoriteCourses.length);
  $("#allCoursesTab").classList.toggle("selected", viewMode === "all");
  $("#favoritesTab").classList.toggle("selected", viewMode === "favorites");
  $("#allCoursesTab").setAttribute("aria-pressed", String(viewMode === "all"));
  $("#favoritesTab").setAttribute("aria-pressed", String(viewMode === "favorites"));
  $("#conflictFreeBtn").classList.toggle("selected", avoidConflicts);
  $("#conflictFreeBtn").setAttribute("aria-pressed", String(avoidConflicts));
  const message = $("#viewMessage");
  const parts = [];
  if (viewMode === "favorites") parts.push("收藏課程儲存在此瀏覽器；僅套用關鍵字及基本篩選。");
  if (avoidConflicts && !blockedSlots().size) parts.push("目前課表沒有已排定的節次，暫時無課程需要排除。");
  message.textContent = parts.join(" ");
  message.classList.toggle("hidden", !parts.length);
}
function makeId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function loadState() {
  try { const parsed = JSON.parse(localStorage.getItem(stateKey) || "null"); if (parsed?.plans?.length && parsed.activePlanId) return parsed; } catch {}
  let legacy = []; try { legacy = JSON.parse(localStorage.getItem(legacyKey) || "[]"); } catch {}
  const id = makeId();
  return { activePlanId: id, plans: [{ id, name: "方案 A", courses: Array.isArray(legacy) ? legacy : [] }] };
}
function saveState() { localStorage.setItem(stateKey, JSON.stringify(state)); updateScheduleCount(); }
function activePlan() {
  let plan = state.plans.find((item) => item.id === state.activePlanId);
  if (!plan) { plan = state.plans[0]; state.activePlanId = plan.id; saveState(); }
  return plan;
}
function selectedCourses() { return activePlan().courses; }
function updateScheduleCount() { $("#scheduleCount").textContent = selectedCourses().length; }

function meetingLabel(course) {
  if (!course.meetings?.length) return "上課時間未提供";
  return course.meetings.map((meeting) => {
    const sections = meeting.sections?.join(", ") || meeting.section_raw || "?";
    const room = meeting.room ? `｜${meeting.room}` : "";
    return `週${weekdays[meeting.weekday] || "?"} ${sections}${room}`;
  }).join("；");
}
function conflict(a, b) {
  for (const ma of a.meetings || []) for (const mb of b.meetings || []) {
    if (!ma.weekday || ma.weekday !== mb.weekday) continue;
    const setA = new Set(ma.sections || []);
    if ((mb.sections || []).some((section) => setA.has(section))) return true;
  }
  return false;
}
function addCourse(course) {
  const courses = selectedCourses();
  if (courses.some((item) => item.id === course.id)) return;
  const conflicts = courses.filter((item) => conflict(item, course));
  if (conflicts.length && !window.confirm(`「${course.name}」會與 ${conflicts.map((item) => item.name).join("、")} 衝堂。仍要加入嗎？`)) return;
  courses.push(course); saveState();
  if (avoidConflicts) search({ resetPage: true }); else renderCourses();
}

function optionLabel(item) { return item.count === undefined ? item.label : `${item.label}（${item.count}）`; }
function fillSelect(selector, options, firstLabel, { disableWhenEmpty = true } = {}) {
  const select = $(selector); if (!select) return;
  const previous = select.value; const values = options || [];
  select.replaceChildren(new Option(firstLabel, ""));
  for (const item of values) select.append(new Option(optionLabel(item), item.value));
  select.disabled = disableWhenEmpty && values.length === 0;
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}
function fillDatalist(selector, options) {
  const list = $(selector); list.replaceChildren();
  for (const item of options || []) { const option = document.createElement("option"); option.value = item.value; option.label = optionLabel(item); list.append(option); }
}
function renderSectionChips() {
  const root = $("#sectionChips"); root.replaceChildren();
  for (const item of facets.sections || []) {
    const button = document.createElement("button"); button.type = "button"; button.className = `filter-chip${selectedSections.has(item.value) ? " selected" : ""}`; button.disabled = !item.count;
    button.innerHTML = `<span>${item.label}</span><small>${item.count ?? 0}</small>`;
    button.setAttribute("aria-pressed", String(selectedSections.has(item.value)));
    button.addEventListener("click", () => {
      selectedSections.has(item.value) ? selectedSections.delete(item.value) : selectedSections.add(item.value);
      renderSectionChips();
      queueSearch();
    });
    root.append(button);
  }
}
const weekdayNames = ["", "週一", "週二", "週三", "週四", "週五", "週六", "週日"];

function queueSearch(delay = 180) {
  clearTimeout(filterDebounce);
  filterDebounce = setTimeout(() => search({ resetPage: true }), delay);
}

function renderChoiceChips(rootId, options, selected, onChange) {
  const root = $(rootId);
  root.replaceChildren();
  for (const item of options) {
    const value = String(item.value);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `filter-chip${selected.has(value) ? " selected" : ""}`;
    button.setAttribute("aria-pressed", String(selected.has(value)));
    button.textContent = item.label;
    button.addEventListener("click", () => {
      if (selected.has(value)) selected.delete(value);
      else selected.add(value);
      onChange();
    });
    root.append(button);
  }
}

function renderGradeChips() {
  const options = linkedOptions?.grades || facets.grades || [];
  renderChoiceChips("#gradeChips", options, selectedGrades, () => {
    renderGradeChips();
    refreshLinkedOptions();
    queueSearch();
  });
}
function renderWeekdayChips() {
  renderChoiceChips("#weekdayChips",
    Array.from({ length: 7 }, (_, index) => ({ value: String(index + 1), label: weekdayNames[index + 1] })),
    selectedWeekdays, () => { renderWeekdayChips(); queueSearch(); });
}

function updateLookupValue(kind) {
  const select = kind === "department" ? $("#departmentSelect") : $("#roomSelect");
  const input = kind === "department" ? $("#departmentLookup") : $("#roomLookup");
  const entries = kind === "department" ? facets.departments || [] : facets.rooms || [];
  const item = entries.find((entry) => String(entry.value) === select.value);
  input.value = item ? String(item.label) : "";
}
function fillLookupOptions() {
  for (const [selector, entries] of [
    ["#departmentSuggestions", facets.departments || []],
    ["#roomSuggestions", facets.rooms || []],
  ]) {
    const root = $(selector);
    root.replaceChildren();
    for (const entry of entries) {
      const option = document.createElement("option");
      option.value = String(entry.label);
      option.label = String(entry.value);
      root.append(option);
    }
  }
  updateLookupValue("department");
  updateLookupValue("room");
}
function commitLookup(kind, allowPartial = false) {
  const select = kind === "department" ? $("#departmentSelect") : $("#roomSelect");
  const input = kind === "department" ? $("#departmentLookup") : $("#roomLookup");
  const items = kind === "department" ? facets.departments || [] : facets.rooms || [];
  const value = input.value.trim().toLowerCase();
  const exact = items.find((item) =>
    String(item.label).toLowerCase() === value || String(item.value).toLowerCase() === value);
  const potential = allowPartial && !exact && value ? items.filter((item) =>
    String(item.label).toLowerCase().includes(value) || String(item.value).toLowerCase().includes(value)) : [];
  const chosen = exact || (potential.length === 1 ? potential[0] : null);
  const nextValue = chosen ? String(chosen.value) : "";
  const changed = select.value !== nextValue;
  select.value = nextValue;
  if (chosen) input.value = String(chosen.label);
  else if (!value) input.value = "";
  if (changed) {
    if (kind === "department") {
      selectedGrades.clear();
      $("#classSelect").value = "";
      refreshLinkedOptions();
    }
    queueSearch();
  }
}

async function refreshLinkedOptions() {
  if (!facets.grades) return;
  const sequence = ++linkedSequence;
  const params = new URLSearchParams();
  for (const [key, selector] of [
    ["department", "#departmentSelect"], ["division", "#divisionSelect"],
    ["study_level", "#studyLevelSelect"],
  ]) if ($(selector).value) params.set(key, $(selector).value);
  if (selectedGrades.size) params.set("grades", [...selectedGrades].join(","));
  try {
    const response = await fetch(`/api/filter-options?${params}`);
    if (!response.ok) throw new Error("無法取得班級選項");
    const options = await response.json();
    if (sequence !== linkedSequence) return;
    linkedOptions = options;
    const allowedGrades = new Set((options.grades || []).map((item) => String(item.value)));
    for (const grade of [...selectedGrades]) if (!allowedGrades.has(grade)) selectedGrades.delete(grade);
    renderGradeChips();
    const oldClass = $("#classSelect").value;
    fillSelect("#classSelect", options.classes || [], "全部班級");
    if (oldClass && $("#classSelect").value !== oldClass) queueSearch();
  } catch (error) {
    if (sequence === linkedSequence) {
      linkedOptions = null;
      renderGradeChips();
    }
  }
}

function applyUrlFilters() {
  const params = new URLSearchParams(location.search);
  const mappings = {
    q: "#searchInput", department: "#departmentSelect", weekday: "#weekdaySelect", section: "#sectionSelect", room: "#roomSelect", grade: "#gradeSelect", division: "#divisionSelect",
    study_level: "#studyLevelSelect", required_elective: "#reqSelect", course_tag: "#courseTagSelect", teaching_language: "#teachingLanguageSelect",
    material_language: "#materialLanguageSelect", teaching_method: "#teachingMethodSelect", assessment: "#assessmentSelect", assessment_style: "#assessmentStyleSelect",
    online_teaching: "#onlineTeachingSelect", relation: "#relationSelect", prerequisite: "#prerequisiteInput", detail_indexed: "#detailIndexedSelect", sort: "#sortSelect",
  };
  for (const [key, selector] of Object.entries(mappings)) {
    const value = params.get(key); const node = $(selector); if (value === null || !node) continue;
    if (node.tagName === "SELECT") { if ([...node.options].some((opt) => opt.value === value)) node.value = value; } else node.value = value;
  }
  const sections = params.get("sections"); if (sections) selectedSections = new Set(sections.split(",").filter(Boolean));
  const grades = params.get("grades") || params.get("grade") || "";
  const days = params.get("weekdays") || params.get("weekday") || "";
  selectedGrades = new Set(grades.split(",").filter((v) => /^[1-8]$/.test(v)));
  selectedWeekdays = new Set(days.split(",").filter((v) => /^[1-7]$/.test(v)));
  $("#gradeSelect").value = "";
  $("#weekdaySelect").value = "";
}

function collectFormValues() {
  const selectors = ["#searchInput", "#departmentSelect", "#weekdaySelect", "#sectionSelect", "#roomSelect", "#creditsSelect", "#reqSelect", "#divisionSelect", "#gradeSelect", "#studyLevelSelect", "#courseTagSelect", "#teacherInput", "#classSelect", "#timeOfDaySelect", "#scheduleSelect", "#teachingLanguageSelect", "#materialLanguageSelect", "#teachingMethodSelect", "#assessmentSelect", "#assessmentStyleSelect", "#onlineTeachingSelect", "#relationSelect", "#prerequisiteInput", "#detailIndexedSelect", "#sortSelect", "#teachingMethodCriterionSelect", "#teachingMethodMinInput", "#assessmentCriterionSelect", "#assessmentMinInput"];
  return Object.fromEntries(selectors.map((selector) => [selector, $(selector)?.value ?? ""]));
}
function restoreFormValues(values) {
  for (const [selector, value] of Object.entries(values)) { const node = $(selector); if (!node) continue; if (node.tagName === "SELECT") { if ([...node.options].some((option) => option.value === value)) node.value = value; } else node.value = value; }
}
async function loadMetaAndFacets({ preserveValues = false } = {}) {
  const previous = preserveValues ? collectFormValues() : null;
  const [metaResponse, facetResponse] = await Promise.all([fetch("/api/meta"), fetch("/api/facets")]); meta = await metaResponse.json(); facets = await facetResponse.json();
  if (!metaResponse.ok) throw new Error(meta.detail || "無法讀取學期資訊"); if (!facetResponse.ok) throw new Error(facets.detail || "無法讀取篩選資料");
  const dataUpdated = meta.course_data_updated_at ? new Date(meta.course_data_updated_at * 1000).toLocaleString("zh-TW", { hour12: false }) : "";
  $("#termText").textContent = [
    `${meta.academic_year} 學年度・第 ${meta.semester} 學期`,
    `${meta.course_count.toLocaleString()} 門課程`,
    meta.course_scope ? `課綱範圍 ${meta.course_scope}` : "",
    dataUpdated ? `更新 ${dataUpdated}` : "",
  ].filter(Boolean).join("  ·  ");
  fillSelect("#departmentSelect", facets.departments, "全部系所"); fillSelect("#sectionSelect", (facets.sections || []).filter((item) => item.count), "全部節次"); fillSelect("#roomSelect", facets.rooms, "全部教室"); fillSelect("#creditsSelect", facets.credits, "不限學分");
  fillSelect("#reqSelect", facets.required_elective, "全部"); fillSelect("#divisionSelect", facets.divisions, "全部部別"); fillSelect("#gradeSelect", facets.grades, "全部年級"); fillSelect("#studyLevelSelect", facets.study_levels, "全部層級");
  fillSelect("#courseTagSelect", facets.course_tags, "全部標籤"); fillSelect("#classSelect", facets.classes, "全部班級"); fillSelect("#teachingLanguageSelect", facets.teaching_languages, "全部授課語言"); fillSelect("#materialLanguageSelect", facets.material_languages, "全部教材語言");
  fillSelect("#teachingMethodSelect", facets.teaching_methods, "全部教學方式"); fillSelect("#assessmentSelect", facets.assessments, "全部評量方式"); fillSelect("#relationSelect", facets.relations, "全部能力／議題"); fillDatalist("#teacherOptions", facets.teachers); renderSectionChips();
  if (previous) restoreFormValues(previous); else applyUrlFilters();
  fillLookupOptions();
  renderGradeChips();
  renderWeekdayChips();
  renderSectionChips();
  await refreshLinkedOptions();
  updateCourseToolsUI();
  const indexed = meta.detail_indexed || 0; const total = meta.course_count || 0;
  $("#enrichedCoverageText").textContent = indexed >= total && total
    ? `完整資料已同步 ${indexed.toLocaleString()} / ${total.toLocaleString()} 門`
    : `完整資料已同步 ${indexed.toLocaleString()} / ${total.toLocaleString()} 門；系統自動更新，無需操作`;
  updateFilterSummary();
}

function buildSearchParams() {
  const params = new URLSearchParams({ page: String(currentPage), page_size: "25", sort: $("#sortSelect").value });
  const mappings = [["q", "#searchInput"], ["department", "#departmentSelect"], ["grade", "#gradeSelect"], ["division", "#divisionSelect"], ["study_level", "#studyLevelSelect"], ["required_elective", "#reqSelect"], ["course_tag", "#courseTagSelect"], ["teacher", "#teacherInput"], ["class_group", "#classSelect"], ["weekday", "#weekdaySelect"], ["section", "#sectionSelect"], ["room", "#roomSelect"], ["time_of_day", "#timeOfDaySelect"], ["schedule", "#scheduleSelect"], ["teaching_language", "#teachingLanguageSelect"], ["material_language", "#materialLanguageSelect"], ["teaching_method", "#teachingMethodSelect"], ["assessment", "#assessmentSelect"], ["assessment_style", "#assessmentStyleSelect"], ["online_teaching", "#onlineTeachingSelect"], ["relation", "#relationSelect"], ["prerequisite", "#prerequisiteInput"], ["detail_indexed", "#detailIndexedSelect"], ["teaching_method_criterion", "#teachingMethodCriterionSelect"], ["teaching_method_min", "#teachingMethodMinInput"], ["assessment_criterion", "#assessmentCriterionSelect"], ["assessment_min", "#assessmentMinInput"]];
  const defaults = new Map([["time_of_day", "all"], ["schedule", "all"], ["assessment_style", "all"], ["online_teaching", "all"], ["detail_indexed", "all"], ["teaching_method_criterion", "dominant"], ["assessment_criterion", "dominant"]]);
  for (const [key, selector] of mappings) { const value = $(selector).value.trim(); if (value && value !== defaults.get(key)) params.set(key, value); }
  if (selectedGrades.size) params.set("grades", [...selectedGrades].join(","));
  if (selectedWeekdays.size) params.set("weekdays", [...selectedWeekdays].join(","));
  const credits = $("#creditsSelect").value; if (credits) { params.set("min_credits", credits); params.set("max_credits", credits); }
  if (selectedSections.size) params.set("sections", [...selectedSections].join(","));
  if ($("#timeOfDaySelect").value !== "all") params.set("include_unknown_schedule", "false");
  if (avoidConflicts) {
    params.set("avoid_conflicts", "1");
    const slots = [...blockedSlots()];
    if (slots.length) params.set("exclude_slots", slots.join(","));
  }
  return params;
}
function updateFilterSummary() {
  const parts = []; const mappings = [["#departmentSelect", "系所"], ["#weekdaySelect", "星期"], ["#sectionSelect", "節次"], ["#roomSelect", "教室"], ["#creditsSelect", "學分"], ["#reqSelect", "必選修"], ["#divisionSelect", "部別"], ["#gradeSelect", "年級"], ["#studyLevelSelect", "層級"], ["#courseTagSelect", "標籤"], ["#teacherInput", "教師"], ["#classSelect", "班別"], ["#teachingLanguageSelect", "授課語言"], ["#materialLanguageSelect", "教材語言"], ["#teachingMethodSelect", "教學方式"], ["#assessmentSelect", "評量方式"], ["#relationSelect", "能力／議題"], ["#prerequisiteInput", "先修"]];
  for (const [selector, label] of mappings) { const node = $(selector); if (!node?.value) continue; const text = node.tagName === "SELECT" ? node.selectedOptions[0].textContent.replace(/（\d+）$/, "") : node.value; parts.push(`${label}：${text}`); }
  if ($("#timeOfDaySelect").value !== "all") parts.push(`時段：${$("#timeOfDaySelect").selectedOptions[0].textContent}`); if ($("#scheduleSelect").value !== "all") parts.push($("#scheduleSelect").selectedOptions[0].textContent);
  if ($("#assessmentStyleSelect").value !== "all") parts.push(`評量類型：${$("#assessmentStyleSelect").selectedOptions[0].textContent}`); if ($("#onlineTeachingSelect").value !== "all") parts.push(`線上：${$("#onlineTeachingSelect").selectedOptions[0].textContent}`); if ($("#detailIndexedSelect").value !== "all") parts.push($("#detailIndexedSelect").selectedOptions[0].textContent); if (selectedSections.size) parts.push(`精確節次：${[...selectedSections].join("、")}`);
  if (avoidConflicts) parts.push("避開衝堂");
  $("#activeFilterText").textContent = parts.length ? parts.join("｜") : "尚未設定篩選條件";
  const advancedNodes = ["#divisionSelect", "#gradeSelect", "#studyLevelSelect", "#courseTagSelect", "#teacherInput", "#classSelect", "#teachingLanguageSelect", "#materialLanguageSelect", "#teachingMethodSelect", "#assessmentSelect", "#relationSelect", "#prerequisiteInput"];
  let count = advancedNodes.filter((selector) => $(selector).value).length + selectedSections.size + Number($("#timeOfDaySelect").value !== "all") + Number($("#scheduleSelect").value !== "all") + Number($("#assessmentStyleSelect").value !== "all") + Number($("#onlineTeachingSelect").value !== "all") + Number($("#detailIndexedSelect").value !== "all"); $("#advancedCount").textContent = count;
}

function matchesFavoriteFilters(course, params) {
  const q = (params.get("q") || "").toLowerCase().trim();
  const haystack = [
    course.name, course.name_en, course.course_code,
    course.teacher, course.department,
  ].join(" ").toLowerCase();
  if (q && !q.split(/\s+/).every((term) => haystack.includes(term))) return false;
  const department = params.get("department");
  if (department && course.department_code !== department && course.department !== department) return false;
  const weekday = Number(params.get("weekday"));
  const section = params.get("section");
  const room = params.get("room");
  if (weekday && !(course.meetings || []).some((m) => m.weekday === weekday)) return false;
  if (section && !(course.meetings || []).some((m) => (m.sections || []).includes(section))) return false;
  if (room && !(course.meetings || []).some((m) => m.room === room)) return false;
  const credits = params.get("min_credits");
  if (credits !== null && Number(course.credits_number) !== Number(credits)) return false;
  const required = params.get("required_elective");
  if (required && course.required_elective !== required) return false;
  if (avoidConflicts && courseOverlaps(course, blockedSlots())) return false;
  return true;
}
function showFavorites(params) {
  const sorted = favoriteCourses.filter((course) => matchesFavoriteFilters(course, params));
  const start = (currentPage - 1) * 25;
  totalResults = sorted.length;
  totalPages = Math.max(1, Math.ceil(totalResults / 25));
  if (currentPage > totalPages) currentPage = totalPages;
  currentCourses = sorted.slice((currentPage - 1) * 25, currentPage * 25);
  $("#status").classList.add("hidden");
  renderCourses(); renderPager();
}

function renderCourses() {
  updateCourseToolsUI();
  const root = $("#courseList"); root.replaceChildren();
  if (!currentCourses.length) { root.innerHTML = '<div class="panel empty-result"><strong>找不到符合條件的課程</strong><span>可清除部分條件，或確認完整搜尋索引是否已涵蓋該進階欄位。</span></div>'; return; }
  const template = $("#courseTemplate");
  for (const course of currentCourses) {
    const node = template.content.cloneNode(true);
    node.querySelector(".course-name").textContent = course.name;
    const favoriteButton = node.querySelector(".favorite-btn");
    const isFavorite = hasFavorite(course.id);
    favoriteButton.textContent = isFavorite ? "★" : "☆";
    favoriteButton.classList.toggle("selected", isFavorite);
    favoriteButton.setAttribute("aria-pressed", String(isFavorite));
    favoriteButton.setAttribute("aria-label", isFavorite ? "取消收藏" : "加入收藏");
    favoriteButton.title = isFavorite ? "取消收藏" : "收藏課程";
    favoriteButton.addEventListener("click", () => toggleFavorite(course));
    const en = node.querySelector(".course-name-en"); en.textContent = course.name_en || ""; if (!course.name_en) en.classList.add("hidden");
    node.querySelector(".req-badge").textContent = course.required_elective || "未標示"; const indexBadge = node.querySelector(".index-badge"); indexBadge.textContent = course.detail_indexed ? "完整索引" : "基本資料"; indexBadge.classList.add(course.detail_indexed ? "fit-badge" : "neutral-badge");
    node.querySelector(".course-meta").textContent = [course.course_code, course.teacher, course.credits !== null && course.credits !== "" ? `${course.credits} 學分` : "", course.department, course.grade ? `${course.grade} 年級` : "", course.division, course.class_group, course.teaching_language ? `授課：${course.teaching_language}` : ""].filter(Boolean).join("｜");
    node.querySelector(".meeting-text").textContent = meetingLabel(course); const tagsRoot = node.querySelector(".course-tags"); for (const tag of course.course_tags || []) { const span = document.createElement("span"); span.className = "course-tag"; span.textContent = tag.label; tagsRoot.append(span); }
    node.querySelector(".outline-link").href = course.outline_url;
    const detailButton = node.querySelector(".detail-btn");
    const staticUnindexed = Boolean(meta?.pages_mode && !course.detail_indexed);
    detailButton.textContent = staticUnindexed ? "完整資料尚未同步" : "完整資料";
    detailButton.disabled = staticUnindexed;
    detailButton.title = staticUnindexed ? "此課尚未完成 GitHub Pages 詳細索引，請先查看官方課綱" : "";
    if (!staticUnindexed) detailButton.addEventListener("click", () => showDetail(course));
    const button = node.querySelector(".add-btn"); const exists = selectedCourses().some((item) => item.id === course.id); button.textContent = exists ? "已在課表" : "加入課表"; button.disabled = exists; button.addEventListener("click", () => addCourse(course)); root.append(node);
  }
}
function renderPager() { $("#resultCount").textContent = `${totalResults.toLocaleString()} 門`; $("#pageText").textContent = `${currentPage} / ${totalPages}`; $("#prevPageBtn").disabled = currentPage <= 1; $("#nextPageBtn").disabled = currentPage >= totalPages; }
async function search({ resetPage = false, updateUrl = true } = {}) {
  if (resetPage) currentPage = 1;
  const sequence = ++searchSequence;
  updateFilterSummary();
  updateCourseToolsUI();
  const params = buildSearchParams();
  if (viewMode === "favorites") {
    showFavorites(params);
    return;
  }
  $("#status").textContent = "讀取課程中…";
  $("#status").classList.remove("hidden");
  try {
    const response = await fetch(`/api/courses?${params}`);
    const data = await response.json();
    if (sequence !== searchSequence) return;
    if (!response.ok) throw new Error(data.detail || "讀取失敗");
    currentCourses = data.items;
    totalResults = data.total;
    currentPage = data.page;
    totalPages = data.total_pages;
    $("#status").classList.add("hidden");
    renderCourses(); renderPager();
    if (updateUrl) {
      const urlParams = new URLSearchParams(params);
      urlParams.delete("page_size");
      urlParams.delete("exclude_slots");
      if (currentPage === 1) urlParams.delete("page");
      history.replaceState(null, "", `${location.pathname}${urlParams.size ? `?${urlParams}` : ""}`);
    }
  } catch (error) {
    if (sequence !== searchSequence) return;
    $("#status").textContent = error.message;
    currentCourses = [];
    totalResults = 0;
    totalPages = 1;
    renderCourses(); renderPager();
  }
}

function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
function compactObjectRows(rows) {
  return (rows || []).map((row) => {
    if (row === null || row === undefined) return "";
    if (typeof row !== "object") return String(row);
    return Object.values(row).filter((value) => value !== null && value !== undefined && value !== "" && typeof value !== "object").join("｜");
  }).filter(Boolean).join("\n");
}
function renderDetail(course) {
  const methods = (course.teaching_methods || []).map((item) => `${item.label} ${item.percent}%`).join("、") || "未提供";
  const assessments = (course.assessments || []).map((item) => `${item.label} ${item.percent}%`).join("、") || "未提供";
  const relations = (course.relations || []).map((item) => {
    const desc = item.description ? `：${item.description}` : "";
    return `${item.label || item.id}${item.strength === "indirect" ? "（間接）" : ""}${desc}`;
  }).join("\n") || "未提供";
  const online = course.online_teaching ? [course.online_teaching.sync ? "同步" : "", course.online_teaching.async ? "非同步" : ""].filter(Boolean).join("＋") || "純實體／未標示線上" : "未提供";
  const teachers = (course.instructors || []).map((item) => [item.name_zh || item.name_en, item.title_zh, item.employment_type_zh].filter(Boolean).join("／")).filter(Boolean).join("、") || course.teacher || "未提供";
  const contact = course.teacher_contact || {};
  const contactText = [
    contact.email ? `Email：${contact.email}` : "",
    contact.office ? `辦公室：${contact.office}` : "",
    contact.course_office_hours ? `Office Hours：${contact.course_office_hours}` : "",
  ].filter(Boolean).join("\n") || "未提供";
  const materials = course.materials || {};
  const materialsText = [
    materials.summary ? `教材概要：${materials.summary}` : "",
    materials.textbook ? `教科書：${materials.textbook}` : "",
    materials.references ? `參考書：${materials.references}` : "",
    materials.platform_url ? `教學平台：${materials.platform_url}` : "",
    compactObjectRows(materials.course_materials || []),
  ].filter(Boolean).join("\n") || course.materials_text || "未提供";
  const weeklyRows = (course.weekly_progress_items || []).map((item) => {
    const head = [item.week !== null && item.week !== undefined ? `第${item.week}週` : "", item.date, item.unit, item.topic, item.notes].filter(Boolean).join(" ");
    const hours = [
      item.physical_hours ? `實體 ${item.physical_hours}h` : "",
      item.sync_online_hours ? `同步 ${item.sync_online_hours}h` : "",
      item.async_online_hours ? `非同步 ${item.async_online_hours}h` : "",
    ].filter(Boolean).join("／");
    return [head, hours].filter(Boolean).join("｜");
  }).join("\n") || course.weekly_progress || "未提供";
  const makeup = compactObjectRows(course.makeup_classes || []) || "未提供";
  const completion = course.outline_completion ? (course.outline_completion.is_done ? "官方標示已完成" : "官方尚未標示完成") : "未提供";
  $("#detailTitle").textContent = course.name;
  $("#detailContent").innerHTML = `<dl class="detail-grid">
    <dt>課號</dt><dd>${escapeHtml(course.course_code || "未提供")}</dd>
    <dt>教師</dt><dd class="preline">${escapeHtml(teachers)}</dd>
    <dt>教師聯絡</dt><dd class="preline">${escapeHtml(contactText)}</dd>
    <dt>授課語言</dt><dd>${escapeHtml(course.teaching_language || "未提供")}</dd>
    <dt>教材語言</dt><dd>${escapeHtml(course.material_language || "未提供")}</dd>
    <dt>時間／教室</dt><dd>${escapeHtml(meetingLabel(course))}</dd>
    <dt>教學方式</dt><dd>${escapeHtml(methods)}</dd>
    <dt>評量方式</dt><dd>${escapeHtml(assessments)}</dd>
    <dt>線上教學</dt><dd>${escapeHtml(online)}</dd>
    <dt>能力／議題</dt><dd class="preline">${escapeHtml(relations)}</dd>
    <dt>先修課程</dt><dd class="preline">${escapeHtml(course.prerequisite || "未提供")}</dd>
    <dt>課程目標</dt><dd class="preline">${escapeHtml(course.objective || "未提供")}</dd>
    <dt>學習規範</dt><dd class="preline">${escapeHtml(course.learning_norms || "未提供")}</dd>
    <dt>其他備註</dt><dd class="preline">${escapeHtml(course.outline_notes || "未提供")}</dd>
    <dt>選課備註</dt><dd class="preline">${escapeHtml(course.enrollment_note || "未提供")}</dd>
    <dt>每週進度</dt><dd class="preline">${escapeHtml(weeklyRows)}</dd>
    <dt>教材／參考資料</dt><dd class="preline">${escapeHtml(materialsText)}</dd>
    <dt>停補課／教師請假</dt><dd class="preline">${escapeHtml(makeup)}</dd>
    <dt>課綱狀態</dt><dd>${escapeHtml(completion)}</dd>
  </dl>`;
}
async function showDetail(course) {
  $("#detailDialog").showModal(); $("#detailTitle").textContent = course.name; $("#detailContent").innerHTML = '<div class="status">載入完整課程資料…</div>';
  try { const response = await fetch(`/api/course/${encodeURIComponent(course.id)}`); const detail = await response.json(); if (!response.ok) throw new Error(detail.detail || "完整資料載入失敗"); renderDetail(detail); if (!course.detail_indexed) { await loadMetaAndFacets({ preserveValues: true }); await search({ updateUrl: false }); } }
  catch (error) { $("#detailContent").innerHTML = `<div class="status">${escapeHtml(error.message)}</div>`; }
}
function resetFilters({ searchNow = true } = {}) {
  for (const selector of ["#searchInput", "#teacherInput", "#prerequisiteInput"]) $(selector).value = "";
  for (const selector of ["#departmentSelect", "#weekdaySelect", "#sectionSelect", "#roomSelect", "#creditsSelect", "#reqSelect", "#divisionSelect", "#gradeSelect", "#studyLevelSelect", "#courseTagSelect", "#classSelect", "#teachingLanguageSelect", "#materialLanguageSelect", "#teachingMethodSelect", "#assessmentSelect", "#relationSelect"]) $(selector).value = "";
  for (const selector of ["#timeOfDaySelect", "#scheduleSelect", "#assessmentStyleSelect", "#onlineTeachingSelect", "#detailIndexedSelect"]) $(selector).value = "all";
  $("#sortSelect").value = "relevance"; $("#teachingMethodCriterionSelect").value = "dominant"; $("#assessmentCriterionSelect").value = "dominant"; $("#teachingMethodMinInput").value = "20"; $("#assessmentMinInput").value = "20"; selectedSections.clear(); avoidConflicts = false; renderSectionChips(); if (searchNow) search({ resetPage: true });
}
function openSchedule() { const popup = window.open("/schedule", "fjuCourseSchedule", "width=1380,height=940,resizable=yes,scrollbars=yes"); popup?.focus(); }

function setFilterPanelOpen(open, { restoreFocus = true } = {}) {
  document.body.classList.toggle("filters-open", open);
  const toggle = $("#mobileFiltersBtn");
  toggle?.setAttribute("aria-expanded", String(open));
  if (open) $("#closeFiltersBtn")?.focus();
  else if (restoreFocus) toggle?.focus();
}

$("#mobileFiltersBtn").addEventListener("click", () => setFilterPanelOpen(true));
$("#closeFiltersBtn").addEventListener("click", () => setFilterPanelOpen(false));
$("#filterBackdrop").addEventListener("click", () => setFilterPanelOpen(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("filters-open")) setFilterPanelOpen(false);
});
const desktopQuery = window.matchMedia("(min-width: 901px)");
desktopQuery.addEventListener("change", (event) => {
  if (event.matches) setFilterPanelOpen(false, { restoreFocus: false });
});

$("#allCoursesTab").addEventListener("click", () => { viewMode = "all"; search({ resetPage: true }); });
$("#favoritesTab").addEventListener("click", () => { viewMode = "favorites"; search({ resetPage: true }); });
$("#conflictFreeBtn").addEventListener("click", () => { avoidConflicts = !avoidConflicts; search({ resetPage: true }); });
document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey
    && !["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName)) {
    event.preventDefault();
    $("#searchInput").focus();
  }
});
$("#searchBtn").addEventListener("click", () => search({ resetPage: true }));
$("#applyFiltersBtn").addEventListener("click", () => { setFilterPanelOpen(false, { restoreFocus: false }); search({ resetPage: true }); });
$("#resetFiltersBtn").addEventListener("click", () => resetFilters());
$("#openScheduleBtn").addEventListener("click", openSchedule);
$("#prevPageBtn").addEventListener("click", () => { if (currentPage > 1) { currentPage -= 1; search(); } }); $("#nextPageBtn").addEventListener("click", () => { if (currentPage < totalPages) { currentPage += 1; search(); } }); $("#searchInput").addEventListener("keydown", (event) => { if (event.key === "Enter") search({ resetPage: true }); });
$("#closeDetailBtn").addEventListener("click", () => $("#detailDialog").close()); $("#detailDialog").addEventListener("click", (event) => { if (event.target === $("#detailDialog")) $("#detailDialog").close(); });
$("#refreshBtn").addEventListener("click", async () => { $("#refreshBtn").disabled = true; try { const response = await fetch("/api/refresh", { method: "POST" }); const data = await response.json(); if (!response.ok) throw new Error(data.detail || "更新失敗"); await loadMetaAndFacets({ preserveValues: true }); await search({ updateUrl: false }); } catch (error) { window.alert(error.message); } finally { $("#refreshBtn").disabled = false; } });
window.addEventListener("storage", (event) => {
  if (event.key === stateKey) {
    state = loadState();
    updateScheduleCount();
    if (avoidConflicts) search({ resetPage: true }); else renderCourses();
  }
  if (event.key === favoriteKey) {
    favoriteCourses = loadLocalList(favoriteKey);
    if (viewMode === "favorites") search({ updateUrl: false }); else renderCourses();
  }
});

try { await loadMetaAndFacets(); updateScheduleCount(); await search({ updateUrl: false }); } catch (error) { $("#status").textContent = error.message; }
