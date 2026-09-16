const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
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
let searchTimer = null;

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(stateKey) || "null");
    if (parsed?.plans?.length && parsed.activePlanId) return parsed;
  } catch {}
  let legacy = [];
  try { legacy = JSON.parse(localStorage.getItem(legacyKey) || "[]"); } catch {}
  const id = makeId();
  return { activePlanId: id, plans: [{ id, name: "方案 A", courses: Array.isArray(legacy) ? legacy : [] }] };
}

function saveState() {
  localStorage.setItem(stateKey, JSON.stringify(state));
  updateScheduleCount();
}

function activePlan() {
  let plan = state.plans.find((item) => item.id === state.activePlanId);
  if (!plan) {
    plan = state.plans[0];
    state.activePlanId = plan.id;
    saveState();
  }
  return plan;
}

function selectedCourses() {
  return activePlan().courses;
}

function updateScheduleCount() {
  $("#scheduleCount").textContent = selectedCourses().length;
}

function meetingLabel(course) {
  if (!course.meetings?.length) return "上課時間未提供";
  return course.meetings.map((meeting) => {
    const sections = meeting.sections?.join(", ") || meeting.section_raw || "?";
    const room = meeting.room ? `｜${meeting.room}` : "";
    return `週${weekdays[meeting.weekday] || "?"} ${sections}${room}`;
  }).join("；");
}

function conflict(a, b) {
  for (const ma of a.meetings || []) {
    for (const mb of b.meetings || []) {
      if (!ma.weekday || ma.weekday !== mb.weekday) continue;
      const aSections = new Set(ma.sections || []);
      if ((mb.sections || []).some((section) => aSections.has(section))) return true;
    }
  }
  return false;
}

function addCourse(course) {
  const courses = selectedCourses();
  if (courses.some((item) => item.id === course.id)) return;
  const conflicts = courses.filter((item) => conflict(item, course));
  if (conflicts.length && !window.confirm(`「${course.name}」會與 ${conflicts.map((item) => item.name).join("、")} 衝堂。仍要加入嗎？`)) return;
  courses.push(course);
  saveState();
  renderCourses();
}

function optionLabel(item) {
  return item.count === undefined ? item.label : `${item.label}（${item.count}）`;
}

function fillSelect(selector, options, firstLabel) {
  const select = $(selector);
  const previous = select.value;
  const values = options || [];
  select.replaceChildren(new Option(values.length ? firstLabel : `${firstLabel}（資料源未提供）`, ""));
  for (const item of values) select.append(new Option(optionLabel(item), item.value));
  select.disabled = values.length === 0;
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

function fillDatalist(selector, options) {
  const list = $(selector);
  list.replaceChildren();
  for (const item of options || []) {
    const option = document.createElement("option");
    option.value = item.value;
    option.label = optionLabel(item);
    list.append(option);
  }
}

function renderSectionChips() {
  const root = $("#sectionChips");
  root.replaceChildren();
  for (const item of facets.sections || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `filter-chip${selectedSections.has(item.value) ? " selected" : ""}`;
    button.disabled = !item.count;
    button.innerHTML = `<span>${item.label}</span><small>${item.count ?? 0}</small>`;
    button.addEventListener("click", () => {
      if (selectedSections.has(item.value)) selectedSections.delete(item.value);
      else selectedSections.add(item.value);
      renderSectionChips();
      updateFilterSummary();
    });
    root.append(button);
  }
}

function applyUrlFilters() {
  const params = new URLSearchParams(location.search);
  const mappings = {
    q: "#searchInput", department: "#departmentSelect", weekday: "#weekdaySelect", section: "#sectionSelect",
    grade: "#gradeSelect", division: "#divisionSelect", required_elective: "#reqSelect", course_tag: "#courseTagSelect",
  };
  for (const [key, selector] of Object.entries(mappings)) {
    const value = params.get(key);
    if (value !== null && $(selector)) $(selector).value = value;
  }
  const sections = params.get("sections");
  if (sections) selectedSections = new Set(sections.split(",").filter(Boolean));
}

async function loadMetaAndFacets() {
  const [metaResponse, facetResponse] = await Promise.all([fetch("/api/meta"), fetch("/api/facets")]);
  meta = await metaResponse.json();
  facets = await facetResponse.json();
  if (!metaResponse.ok) throw new Error(meta.detail || "無法讀取學期資訊");
  if (!facetResponse.ok) throw new Error(facets.detail || "無法讀取篩選資料");

  $("#termText").textContent = `資料來源：輔仁大學公開課程大綱 API｜${meta.academic_year} 學年度第 ${meta.semester} 學期`;
  fillSelect("#departmentSelect", facets.departments, "全部系所");
  fillSelect("#sectionSelect", facets.sections?.filter((item) => item.count), "全部節次");
  fillSelect("#creditsSelect", facets.credits, "不限學分");
  fillSelect("#reqSelect", facets.required_elective, "全部");
  fillSelect("#divisionSelect", facets.divisions, "全部部別");
  fillSelect("#gradeSelect", facets.grades, "全部年級");
  fillSelect("#courseTagSelect", facets.course_tags, "全部標籤");
  fillSelect("#classSelect", facets.classes, "全部班別");
  fillDatalist("#teacherOptions", facets.teachers);
  $("#teacherInput").disabled = !(facets.teachers || []).length;
  $("#teacherInput").placeholder = (facets.teachers || []).length ? "輸入教師姓名" : "資料源未提供教師清單";
  applyUrlFilters();
  renderSectionChips();
}

function buildSearchParams() {
  const params = new URLSearchParams({ page: String(currentPage), page_size: "25", sort: $("#sortSelect").value });
  const mappings = [
    ["q", "#searchInput"], ["department", "#departmentSelect"], ["grade", "#gradeSelect"], ["division", "#divisionSelect"],
    ["required_elective", "#reqSelect"], ["course_tag", "#courseTagSelect"], ["teacher", "#teacherInput"], ["class_group", "#classSelect"],
    ["weekday", "#weekdaySelect"], ["section", "#sectionSelect"], ["time_of_day", "#timeOfDaySelect"], ["schedule", "#scheduleSelect"],
  ];
  for (const [key, selector] of mappings) {
    const value = $(selector).value.trim();
    if (value && !(key === "time_of_day" && value === "all") && !(key === "schedule" && value === "all")) params.set(key, value);
  }
  const credits = $("#creditsSelect").value;
  if (credits) {
    params.set("min_credits", credits);
    params.set("max_credits", credits);
  }
  if (selectedSections.size) params.set("sections", [...selectedSections].join(","));
  if ($("#timeOfDaySelect").value !== "all") params.set("include_unknown_schedule", "false");
  return params;
}

function updateFilterSummary() {
  const parts = [];
  const mappings = [
    ["#departmentSelect", "系所"], ["#weekdaySelect", "星期"], ["#sectionSelect", "節次"], ["#creditsSelect", "學分"],
    ["#reqSelect", "必選修"], ["#divisionSelect", "部別"], ["#gradeSelect", "年級"], ["#courseTagSelect", "標籤"],
    ["#teacherInput", "教師"], ["#classSelect", "班別"],
  ];
  for (const [selector, label] of mappings) {
    const node = $(selector);
    if (node?.value) parts.push(`${label}：${node.tagName === "SELECT" ? node.selectedOptions[0].textContent.replace(/（\d+）$/, "") : node.value}`);
  }
  if ($("#timeOfDaySelect").value !== "all") parts.push(`時段：${$("#timeOfDaySelect").selectedOptions[0].textContent}`);
  if ($("#scheduleSelect").value !== "all") parts.push($("#scheduleSelect").selectedOptions[0].textContent);
  if (selectedSections.size) parts.push(`精確節次：${[...selectedSections].join("、")}`);
  $("#activeFilterText").textContent = parts.length ? parts.join("｜") : "未套用額外條件";
  const advancedSelectors = ["#divisionSelect", "#gradeSelect", "#courseTagSelect", "#teacherInput", "#classSelect"];
  let count = advancedSelectors.filter((selector) => $(selector).value).length + Number($("#timeOfDaySelect").value !== "all") + Number($("#scheduleSelect").value !== "all") + selectedSections.size;
  $("#advancedCount").textContent = count;
}

function renderCourses() {
  const root = $("#courseList");
  root.replaceChildren();
  if (!currentCourses.length) {
    root.innerHTML = '<div class="panel empty-result"><strong>找不到符合條件的課程</strong><span>可嘗試減少節次、系所或標籤限制。</span></div>';
    return;
  }
  const template = $("#courseTemplate");
  for (const course of currentCourses) {
    const node = template.content.cloneNode(true);
    node.querySelector(".course-name").textContent = course.name;
    const en = node.querySelector(".course-name-en");
    en.textContent = course.name_en || "";
    if (!course.name_en) en.classList.add("hidden");
    node.querySelector(".req-badge").textContent = course.required_elective || "未標示";
    node.querySelector(".course-meta").textContent = [
      course.course_code,
      course.teacher,
      course.credits !== null && course.credits !== "" ? `${course.credits} 學分` : "",
      course.department,
      course.grade ? `${course.grade} 年級` : "",
      course.division,
      course.class_group,
    ].filter(Boolean).join("｜");
    node.querySelector(".meeting-text").textContent = meetingLabel(course);
    const tagsRoot = node.querySelector(".course-tags");
    for (const tag of course.course_tags || []) {
      const span = document.createElement("span");
      span.className = "course-tag";
      span.textContent = tag.label;
      tagsRoot.append(span);
    }
    const link = node.querySelector(".outline-link");
    link.href = course.outline_url;
    const button = node.querySelector(".add-btn");
    const exists = selectedCourses().some((item) => item.id === course.id);
    button.textContent = exists ? "已在課表" : "加入課表";
    button.disabled = exists;
    button.addEventListener("click", () => addCourse(course));
    root.append(node);
  }
}

function renderPager() {
  $("#resultCount").textContent = `共 ${totalResults.toLocaleString()} 門｜本頁 ${currentCourses.length} 門`;
  $("#pageText").textContent = `${currentPage} / ${totalPages}`;
  $("#prevPageBtn").disabled = currentPage <= 1;
  $("#nextPageBtn").disabled = currentPage >= totalPages;
}

async function search({ resetPage = false, updateUrl = true } = {}) {
  if (resetPage) currentPage = 1;
  updateFilterSummary();
  $("#status").textContent = "載入中…";
  $("#status").classList.remove("hidden");
  try {
    const params = buildSearchParams();
    const response = await fetch(`/api/courses?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "讀取失敗");
    currentCourses = data.items;
    totalResults = data.total;
    currentPage = data.page;
    totalPages = data.total_pages;
    $("#status").classList.add("hidden");
    renderCourses();
    renderPager();
    if (updateUrl) {
      const urlParams = new URLSearchParams(params);
      urlParams.delete("page_size");
      urlParams.delete("sort");
      if (currentPage === 1) urlParams.delete("page");
      history.replaceState(null, "", `${location.pathname}${urlParams.size ? `?${urlParams}` : ""}`);
    }
  } catch (error) {
    $("#status").textContent = error.message;
    currentCourses = [];
    totalResults = 0;
    renderCourses();
    renderPager();
  }
}

function resetFilters() {
  for (const selector of ["#searchInput", "#teacherInput"]) $(selector).value = "";
  for (const selector of ["#departmentSelect", "#weekdaySelect", "#sectionSelect", "#creditsSelect", "#reqSelect", "#divisionSelect", "#gradeSelect", "#courseTagSelect", "#classSelect"]) $(selector).value = "";
  $("#timeOfDaySelect").value = "all";
  $("#scheduleSelect").value = "all";
  $("#sortSelect").value = "name";
  selectedSections.clear();
  renderSectionChips();
  search({ resetPage: true });
}

function openSchedule() {
  const popup = window.open("/schedule", "fjuCourseSchedule", "width=1280,height=900,resizable=yes,scrollbars=yes");
  popup?.focus();
}

$("#searchBtn").addEventListener("click", () => search({ resetPage: true }));
$("#applyFiltersBtn").addEventListener("click", () => search({ resetPage: true }));
$("#resetFiltersBtn").addEventListener("click", resetFilters);
$("#openScheduleBtn").addEventListener("click", openSchedule);
$("#prevPageBtn").addEventListener("click", () => { if (currentPage > 1) { currentPage -= 1; search(); } });
$("#nextPageBtn").addEventListener("click", () => { if (currentPage < totalPages) { currentPage += 1; search(); } });

$("#searchInput").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => search({ resetPage: true }), 300);
});
$("#searchInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") { clearTimeout(searchTimer); search({ resetPage: true }); }
});

for (const selector of ["#departmentSelect", "#weekdaySelect", "#sectionSelect", "#creditsSelect", "#reqSelect"]) {
  $(selector).addEventListener("change", () => search({ resetPage: true }));
}
for (const selector of ["#divisionSelect", "#gradeSelect", "#courseTagSelect", "#teacherInput", "#classSelect", "#timeOfDaySelect", "#scheduleSelect", "#sortSelect"]) {
  $(selector).addEventListener("change", updateFilterSummary);
  $(selector).addEventListener("input", updateFilterSummary);
}

$("#refreshBtn").addEventListener("click", async () => {
  const button = $("#refreshBtn");
  button.disabled = true;
  button.textContent = "更新中…";
  try {
    const response = await fetch("/api/refresh", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "更新失敗");
    await loadMetaAndFacets();
    await search({ resetPage: true });
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "更新課程資料";
  }
});

window.addEventListener("storage", (event) => {
  if (event.key === stateKey) {
    state = loadState();
    updateScheduleCount();
    renderCourses();
  }
});

updateScheduleCount();
try {
  await loadMetaAndFacets();
  await search({ resetPage: true, updateUrl: false });
  updateFilterSummary();
} catch (error) {
  $("#status").textContent = error.message;
}
