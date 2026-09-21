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
let indexPollTimer = null;

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
  courses.push(course); saveState(); renderCourses();
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
    button.addEventListener("click", () => { selectedSections.has(item.value) ? selectedSections.delete(item.value) : selectedSections.add(item.value); renderSectionChips(); updateFilterSummary(); });
    root.append(button);
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
}

function indexPercent(indexed, total) { return total ? Math.min(100, Math.round(indexed / total * 100)) : 0; }
function renderIndexStatus(status) {
  const indexed = status.catalog_indexed ?? meta?.detail_indexed ?? 0; const total = status.catalog_total ?? meta?.course_count ?? 0; const percent = indexPercent(indexed, total);
  $("#indexProgressBar").style.width = `${percent}%`; $("#buildIndexBtn").disabled = Boolean(status.running) || Boolean(status.complete);
  if (status.complete) { $("#indexStatusText").textContent = `完整：${indexed.toLocaleString()} / ${total.toLocaleString()} 門（100%）`; $("#buildIndexBtn").textContent = "完整索引已建立"; }
  else if (status.running) { $("#indexStatusText").textContent = `建立中：${indexed.toLocaleString()} / ${total.toLocaleString()} 門（${percent}%）${status.current ? `｜${status.current}` : ""}${status.failed ? `｜失敗 ${status.failed}` : ""}`; $("#buildIndexBtn").textContent = "索引建立中…"; }
  else { $("#indexStatusText").textContent = `已索引 ${indexed.toLocaleString()} / ${total.toLocaleString()} 門（${percent}%）。可續跑。`; $("#buildIndexBtn").textContent = "建立／續跑完整索引"; }
  if (status.last_error) $("#indexStatusText").textContent += `｜錯誤：${status.last_error}`;
}
async function pollIndexStatus({ refreshFacetsWhenDone = false } = {}) {
  try {
    const response = await fetch("/api/index/status"); const status = await response.json(); if (!response.ok) throw new Error(status.detail || "索引狀態讀取失敗");
    renderIndexStatus(status);
    if (status.running) { clearTimeout(indexPollTimer); indexPollTimer = setTimeout(() => pollIndexStatus({ refreshFacetsWhenDone: true }), 1600); }
    else if (refreshFacetsWhenDone) { await loadMetaAndFacets({ preserveValues: true }); await search(); }
  } catch (error) { $("#indexStatusText").textContent = error.message; }
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
    "輔仁大學公開課程大綱 API",
    `${meta.academic_year} 學年度第 ${meta.semester} 學期`,
    meta.course_scope ? `課綱範圍 ${meta.course_scope}` : "",
    `${meta.course_count.toLocaleString()} 門`,
    dataUpdated ? `資料更新：${dataUpdated}` : "",
  ].filter(Boolean).join("｜");
  fillSelect("#departmentSelect", facets.departments, "全部系所"); fillSelect("#sectionSelect", (facets.sections || []).filter((item) => item.count), "全部節次"); fillSelect("#roomSelect", facets.rooms, "全部教室"); fillSelect("#creditsSelect", facets.credits, "不限學分");
  fillSelect("#reqSelect", facets.required_elective, "全部"); fillSelect("#divisionSelect", facets.divisions, "全部部別"); fillSelect("#gradeSelect", facets.grades, "全部年級"); fillSelect("#studyLevelSelect", facets.study_levels, "全部層級");
  fillSelect("#courseTagSelect", facets.course_tags, "全部標籤"); fillSelect("#classSelect", facets.classes, "全部班別"); fillSelect("#teachingLanguageSelect", facets.teaching_languages, "全部授課語言"); fillSelect("#materialLanguageSelect", facets.material_languages, "全部教材語言");
  fillSelect("#teachingMethodSelect", facets.teaching_methods, "全部教學方式"); fillSelect("#assessmentSelect", facets.assessments, "全部評量方式"); fillSelect("#relationSelect", facets.relations, "全部能力／議題"); fillDatalist("#teacherOptions", facets.teachers); renderSectionChips();
  if (previous) restoreFormValues(previous); else applyUrlFilters();
  const indexed = meta.detail_indexed || 0; const total = meta.course_count || 0; $("#enrichedCoverageText").textContent = `目前完整索引 ${indexed.toLocaleString()} / ${total.toLocaleString()} 門；進階條件只會正確涵蓋已索引課程。`;
  renderIndexStatus({ catalog_indexed: indexed, catalog_total: total, complete: meta.detail_index_complete, running: false }); updateFilterSummary();
}

function buildSearchParams() {
  const params = new URLSearchParams({ page: String(currentPage), page_size: "25", sort: $("#sortSelect").value });
  const mappings = [["q", "#searchInput"], ["department", "#departmentSelect"], ["grade", "#gradeSelect"], ["division", "#divisionSelect"], ["study_level", "#studyLevelSelect"], ["required_elective", "#reqSelect"], ["course_tag", "#courseTagSelect"], ["teacher", "#teacherInput"], ["class_group", "#classSelect"], ["weekday", "#weekdaySelect"], ["section", "#sectionSelect"], ["room", "#roomSelect"], ["time_of_day", "#timeOfDaySelect"], ["schedule", "#scheduleSelect"], ["teaching_language", "#teachingLanguageSelect"], ["material_language", "#materialLanguageSelect"], ["teaching_method", "#teachingMethodSelect"], ["assessment", "#assessmentSelect"], ["assessment_style", "#assessmentStyleSelect"], ["online_teaching", "#onlineTeachingSelect"], ["relation", "#relationSelect"], ["prerequisite", "#prerequisiteInput"], ["detail_indexed", "#detailIndexedSelect"], ["teaching_method_criterion", "#teachingMethodCriterionSelect"], ["teaching_method_min", "#teachingMethodMinInput"], ["assessment_criterion", "#assessmentCriterionSelect"], ["assessment_min", "#assessmentMinInput"]];
  const defaults = new Map([["time_of_day", "all"], ["schedule", "all"], ["assessment_style", "all"], ["online_teaching", "all"], ["detail_indexed", "all"], ["teaching_method_criterion", "dominant"], ["assessment_criterion", "dominant"]]);
  for (const [key, selector] of mappings) { const value = $(selector).value.trim(); if (value && value !== defaults.get(key)) params.set(key, value); }
  const credits = $("#creditsSelect").value; if (credits) { params.set("min_credits", credits); params.set("max_credits", credits); }
  if (selectedSections.size) params.set("sections", [...selectedSections].join(",")); if ($("#timeOfDaySelect").value !== "all") params.set("include_unknown_schedule", "false"); return params;
}
function updateFilterSummary() {
  const parts = []; const mappings = [["#departmentSelect", "系所"], ["#weekdaySelect", "星期"], ["#sectionSelect", "節次"], ["#roomSelect", "教室"], ["#creditsSelect", "學分"], ["#reqSelect", "必選修"], ["#divisionSelect", "部別"], ["#gradeSelect", "年級"], ["#studyLevelSelect", "層級"], ["#courseTagSelect", "標籤"], ["#teacherInput", "教師"], ["#classSelect", "班別"], ["#teachingLanguageSelect", "授課語言"], ["#materialLanguageSelect", "教材語言"], ["#teachingMethodSelect", "教學方式"], ["#assessmentSelect", "評量方式"], ["#relationSelect", "能力／議題"], ["#prerequisiteInput", "先修"]];
  for (const [selector, label] of mappings) { const node = $(selector); if (!node?.value) continue; const text = node.tagName === "SELECT" ? node.selectedOptions[0].textContent.replace(/（\d+）$/, "") : node.value; parts.push(`${label}：${text}`); }
  if ($("#timeOfDaySelect").value !== "all") parts.push(`時段：${$("#timeOfDaySelect").selectedOptions[0].textContent}`); if ($("#scheduleSelect").value !== "all") parts.push($("#scheduleSelect").selectedOptions[0].textContent);
  if ($("#assessmentStyleSelect").value !== "all") parts.push(`評量類型：${$("#assessmentStyleSelect").selectedOptions[0].textContent}`); if ($("#onlineTeachingSelect").value !== "all") parts.push(`線上：${$("#onlineTeachingSelect").selectedOptions[0].textContent}`); if ($("#detailIndexedSelect").value !== "all") parts.push($("#detailIndexedSelect").selectedOptions[0].textContent); if (selectedSections.size) parts.push(`精確節次：${[...selectedSections].join("、")}`);
  $("#activeFilterText").textContent = parts.length ? parts.join("｜") : "未套用額外條件";
  const advancedNodes = ["#divisionSelect", "#gradeSelect", "#studyLevelSelect", "#courseTagSelect", "#teacherInput", "#classSelect", "#teachingLanguageSelect", "#materialLanguageSelect", "#teachingMethodSelect", "#assessmentSelect", "#relationSelect", "#prerequisiteInput"];
  let count = advancedNodes.filter((selector) => $(selector).value).length + selectedSections.size + Number($("#timeOfDaySelect").value !== "all") + Number($("#scheduleSelect").value !== "all") + Number($("#assessmentStyleSelect").value !== "all") + Number($("#onlineTeachingSelect").value !== "all") + Number($("#detailIndexedSelect").value !== "all"); $("#advancedCount").textContent = count;
}

function renderCourses() {
  const root = $("#courseList"); root.replaceChildren();
  if (!currentCourses.length) { root.innerHTML = '<div class="panel empty-result"><strong>找不到符合條件的課程</strong><span>可清除部分條件，或確認完整搜尋索引是否已涵蓋該進階欄位。</span></div>'; return; }
  const template = $("#courseTemplate");
  for (const course of currentCourses) {
    const node = template.content.cloneNode(true); node.querySelector(".course-name").textContent = course.name;
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
function renderPager() { $("#resultCount").textContent = `共 ${totalResults.toLocaleString()} 門｜本頁 ${currentCourses.length} 門`; $("#pageText").textContent = `${currentPage} / ${totalPages}`; $("#prevPageBtn").disabled = currentPage <= 1; $("#nextPageBtn").disabled = currentPage >= totalPages; }
async function search({ resetPage = false, updateUrl = true } = {}) {
  if (resetPage) currentPage = 1; updateFilterSummary(); $("#status").textContent = "載入中…"; $("#status").classList.remove("hidden");
  try { const params = buildSearchParams(); const response = await fetch(`/api/courses?${params}`); const data = await response.json(); if (!response.ok) throw new Error(data.detail || "讀取失敗"); currentCourses = data.items; totalResults = data.total; currentPage = data.page; totalPages = data.total_pages; $("#status").classList.add("hidden"); renderCourses(); renderPager(); if (updateUrl) { const urlParams = new URLSearchParams(params); urlParams.delete("page_size"); if (currentPage === 1) urlParams.delete("page"); history.replaceState(null, "", `${location.pathname}${urlParams.size ? `?${urlParams}` : ""}`); } }
  catch (error) { $("#status").textContent = error.message; currentCourses = []; totalResults = 0; renderCourses(); renderPager(); }
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
function resetFilters() {
  for (const selector of ["#searchInput", "#teacherInput", "#prerequisiteInput"]) $(selector).value = "";
  for (const selector of ["#departmentSelect", "#weekdaySelect", "#sectionSelect", "#roomSelect", "#creditsSelect", "#reqSelect", "#divisionSelect", "#gradeSelect", "#studyLevelSelect", "#courseTagSelect", "#classSelect", "#teachingLanguageSelect", "#materialLanguageSelect", "#teachingMethodSelect", "#assessmentSelect", "#relationSelect"]) $(selector).value = "";
  for (const selector of ["#timeOfDaySelect", "#scheduleSelect", "#assessmentStyleSelect", "#onlineTeachingSelect", "#detailIndexedSelect"]) $(selector).value = "all";
  $("#sortSelect").value = "relevance"; $("#teachingMethodCriterionSelect").value = "dominant"; $("#assessmentCriterionSelect").value = "dominant"; $("#teachingMethodMinInput").value = "20"; $("#assessmentMinInput").value = "20"; selectedSections.clear(); renderSectionChips(); search({ resetPage: true });
}
function openSchedule() { const popup = window.open("/schedule", "fjuCourseSchedule", "width=1380,height=940,resizable=yes,scrollbars=yes"); popup?.focus(); }

$("#searchBtn").addEventListener("click", () => search({ resetPage: true })); $("#applyFiltersBtn").addEventListener("click", () => search({ resetPage: true })); $("#resetFiltersBtn").addEventListener("click", resetFilters); $("#openScheduleBtn").addEventListener("click", openSchedule);
$("#prevPageBtn").addEventListener("click", () => { if (currentPage > 1) { currentPage -= 1; search(); } }); $("#nextPageBtn").addEventListener("click", () => { if (currentPage < totalPages) { currentPage += 1; search(); } }); $("#searchInput").addEventListener("keydown", (event) => { if (event.key === "Enter") search({ resetPage: true }); });
$("#closeDetailBtn").addEventListener("click", () => $("#detailDialog").close()); $("#detailDialog").addEventListener("click", (event) => { if (event.target === $("#detailDialog")) $("#detailDialog").close(); });
$("#buildIndexBtn").addEventListener("click", async () => { $("#buildIndexBtn").disabled = true; try { const response = await fetch("/api/index/start", { method: "POST" }); const data = await response.json(); if (!response.ok) throw new Error(data.detail || "無法啟動索引"); renderIndexStatus(data); pollIndexStatus({ refreshFacetsWhenDone: true }); } catch (error) { $("#indexStatusText").textContent = error.message; $("#buildIndexBtn").disabled = false; } });
$("#refreshBtn").addEventListener("click", async () => { $("#refreshBtn").disabled = true; try { const response = await fetch("/api/refresh", { method: "POST" }); const data = await response.json(); if (!response.ok) throw new Error(data.detail || "更新失敗"); await loadMetaAndFacets({ preserveValues: true }); await search({ updateUrl: false }); } catch (error) { window.alert(error.message); } finally { $("#refreshBtn").disabled = false; } });
window.addEventListener("storage", (event) => { if (event.key === stateKey) { state = loadState(); updateScheduleCount(); renderCourses(); } });

try { await loadMetaAndFacets(); updateScheduleCount(); await search({ updateUrl: false }); await pollIndexStatus(); } catch (error) { $("#status").textContent = error.message; }
