import { displayStudyLevel, getLookupMatches, departmentName } from "./filter-ui.mjs";
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
  // Busy blocks created in Timetable 2.0 also count as unavailable slots.
  const order = ["D0","D1","D2","D3","D4","DN","D5","D6","D7","D8","E0","E1","E2","E3","E4"];
  for (const block of activePlan()?.busyBlocks || []) {
    const start = order.indexOf(block.start), end = order.indexOf(block.end);
    if (start < 0 || end < start || !Number.isInteger(Number(block.weekday)) || Number(block.weekday) < 1 || Number(block.weekday) > 7) continue;
    for (const section of order.slice(start, end + 1)) used.add(`${block.weekday}:${section}`);
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
  $("#resultsHeading").textContent = viewMode === "favorites" ? "我的收藏" : "搜尋結果";
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
function ensureStateTerm() {
  if (!meta?.academic_year || !meta?.semester) return;
  const key = `${meta.academic_year}-${meta.semester}`;
  let changed = false;
  for (const plan of state.plans) {
    if (!plan.termKey) { plan.termKey = key; changed = true; }
    if (!Array.isArray(plan.busyBlocks)) { plan.busyBlocks = []; changed = true; }
  }
  if (!state.plans.some((plan) => plan.termKey === key)) {
    const id = makeId();
    state.plans.push({ id, name: "新學期方案", termKey: key, courses: [], busyBlocks: [] });
    state.activePlanId = id;
    changed = true;
  } else if (state.plans.find((plan) => plan.id === state.activePlanId)?.termKey !== key) {
    state.activePlanId = state.plans.find((plan) => plan.termKey === key).id;
    changed = true;
  }
  if (changed) saveState();
}
function activePlan() {
  let plan = state.plans.find((item) => item.id === state.activePlanId);
  if (!plan) { plan = state.plans[0]; state.activePlanId = plan.id; saveState(); }
  return plan;
}
function selectedCourses() { return activePlan().courses; }
function updateScheduleCount() {
  const courses = selectedCourses();
  $("#scheduleCount").textContent = String(courses.length);
  $("#plannerCourseCount").textContent = `${courses.length} 門課`;
  const credits = courses.reduce((sum, course) => {
    const raw = course.credits_number ?? course.credits;
    const value = Number(raw);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
  $("#plannerCredits").textContent = `${Math.round(credits * 10) / 10} 學分`;
  const root = $("#plannerCourseList");
  root.replaceChildren();
  if (!courses.length) {
    const empty = document.createElement("p");
    empty.className = "planning-empty";
    empty.textContent = "還沒加入課程。從搜尋結果按「加入課表」開始。";
    root.append(empty);
    return;
  }
  for (const course of courses.slice(0, 4)) {
    const row = document.createElement("div");
    row.className = "planning-course-row";
    const code = document.createElement("span");
    code.className = "planning-course-code";
    code.textContent = course.course_code || "課程";
    const name = document.createElement("span");
    name.className = "planning-course-name";
    name.textContent = course.name || "未命名課程";
    row.append(code, name);
    root.append(row);
  }
  if (courses.length > 4) {
    const more = document.createElement("p");
    more.className = "planning-more";
    more.textContent = `另有 ${courses.length - 4} 門課程`;
    root.append(more);
  }
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
  const blocked = new Set();
  const order = ["D0","D1","D2","D3","D4","DN","D5","D6","D7","D8","E0","E1","E2","E3","E4"];
  for (const b of activePlan().busyBlocks || []) {
    const start = order.indexOf(b.start), end = order.indexOf(b.end);
    if (start < 0 || end < start) continue;
    for (const section of order.slice(start, end + 1)) blocked.add(`${b.weekday}:${section}`);
  }
  const clashesBusy = (course.meetings || []).some((meeting) =>
    (meeting.sections || []).some((section) => blocked.has(`${meeting.weekday}:${section}`)));
  const why = conflicts.map((item) => item.name).concat(clashesBusy ? ["自訂忙碌時段"] : []);
  if (why.length && !window.confirm(`「${course.name}」會與 ${why.join("、")} 衝堂。仍要加入嗎？`)) return;
  if (!(course.meetings || []).some((m) => m.weekday && (m.sections || []).length)
    && !window.confirm("這門課的上課時間未定，無法完整檢查衝堂。仍要加入嗎？")) return;
  courses.push(course); saveState();
  if (avoidConflicts) search({ resetPage: true }); else renderCourses();
}

function optionLabel(item) { return item.count === undefined ? item.label : `${item.label}（${item.count}）`; }
function fillSelect(selector, options, firstLabel, { disableWhenEmpty = true } = {}) {
  const select = $(selector); if (!select) return;
  const previous = select.value; const values = options || [];
  select.replaceChildren(new Option(firstLabel, ""));
  for (const item of values) select.append(new Option(
    selector === "#studyLevelSelect"
      ? `${displayStudyLevel(item.value)}${Number.isFinite(Number(item.count)) ? `（${item.count} 門）` : ""}`
      : optionLabel(item),
    item.value
  ));
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

const lookupState = {
  department: {open:false, activeIndex:-1, choices:[]},
  room: {open:false, activeIndex:-1, choices:[]},
};
function lookupParts(kind) {
  return {
    input: kind === "department" ? $("#departmentLookup") : $("#roomLookup"),
    select: kind === "department" ? $("#departmentSelect") : $("#roomSelect"),
    menu: kind === "department" ? $("#departmentMenu") : $("#roomMenu"),
    field: kind === "department" ? $("#departmentLookupField") : $("#roomLookupField"),
    items: kind === "department" ? facets.departments || [] : facets.rooms || [],
  };
}
function updateLookupValue(kind) {
  const {input, select, items} = lookupParts(kind);
  const chosen = items.find((item) => String(item.value) === select.value);
  input.value = chosen ? (kind === "department" ? departmentName(chosen) : String(chosen.label ?? chosen.value)) : "";
}
function hideLookup(kind, {restore=false}={}) {
  const {input,menu}=lookupParts(kind);
  const state=lookupState[kind];
  state.open=false;
  state.activeIndex=-1;
  state.choices=[];
  menu.classList.add("hidden");
  input.setAttribute("aria-expanded","false");
  input.removeAttribute("aria-activedescendant");
  if(restore)updateLookupValue(kind);
}
function chooseLookup(kind,item) {
  const {input,select}=lookupParts(kind);
  const previous=select.value;
  select.value=item?.value || "";
  updateLookupValue(kind);
  hideLookup(kind);
  if(previous !== select.value) {
    if(kind === "department") {
      selectedGrades.clear();
      $("#classSelect").value="";
      refreshLinkedOptions();
    }
    queueSearch();
  }
  input.focus();
}
function highlightLookup(kind,index) {
  const {input,menu}=lookupParts(kind);
  const state=lookupState[kind];
  const entries=[...menu.querySelectorAll('[role="option"]')];
  if(!entries.length)return;
  const next=Math.max(0,Math.min(index,entries.length-1));
  state.activeIndex=next;
  for(const [i,entry] of entries.entries()) {
    entry.classList.toggle("active",i===next);
    entry.setAttribute("aria-selected",String(i===next));
  }
  input.setAttribute("aria-activedescendant",entries[next].id);
  entries[next].scrollIntoView({block:"nearest"});
}
function showLookup(kind,{browse=false}={}) {
  const {input,menu,items}=lookupParts(kind),state=lookupState[kind];
  const chosen=lookupParts(kind).select.value;
  const query=browse ? "" : input.value.trim();
  const results=getLookupMatches(items,kind,query,50);
  menu.replaceChildren();
  state.open=true;
  state.activeIndex=-1;
  state.choices=[];
  input.setAttribute("aria-expanded","true");
  input.removeAttribute("aria-activedescendant");
  const entries=[];
  // Make "All" a real option so clearing a filter is always discoverable.
  entries.push({value:"",displayLabel:kind==="department"?"全部系所":"全部教室",count:null});
  entries.push(...results);
  entries.forEach((item,i)=>{
    const option=document.createElement("button");
    option.id=kind+"LookupOption-"+i;
    option.type="button";
    option.className="lookup-option";
    option.setAttribute("role","option");
    option.setAttribute("aria-selected","false");
    if(String(item.value)===String(chosen))option.classList.add("is-selected");
    const label=document.createElement("span");
    label.className="lookup-option-main";
    label.textContent=item.displayLabel;
    option.append(label);
    if(item.value) {
      const detail=document.createElement("span");
      detail.className="lookup-option-detail";
      const parts=[];
      if(kind==="department")parts.push("代碼 "+item.value);
      if(kind==="room" && /^\d{1,2}$/.test(item.value))parts.push("未標準化代碼");
      if(Number.isFinite(Number(item.count)))parts.push(item.count+" 門");
      detail.textContent=parts.join(" · ");
      option.append(detail);
    }
    option.addEventListener("pointerdown",(event)=>event.preventDefault());
    option.addEventListener("click",()=>chooseLookup(kind,item));
    option.addEventListener("mouseenter",()=>highlightLookup(kind,i));
    menu.append(option);
  });
  state.choices=entries;
  if(!results.length && query) {
    const empty=document.createElement("p");
    empty.className="lookup-empty";
    empty.textContent="找不到符合的"+(kind==="department"?"系所":"教室")+"，請試其他關鍵字。";
    menu.append(empty);
  } else if(results.length===50) {
    const note=document.createElement("p");
    note.className="lookup-footnote";
    note.textContent="只顯示前 50 筆；輸入名稱或代碼可縮小範圍";
    menu.append(note);
  }
  menu.classList.remove("hidden");
  const box=lookupParts(kind).field.getBoundingClientRect();
  const below=window.innerHeight-box.bottom;
  const above=box.top;
  menu.classList.toggle("lookup-up",below<245 && above>below);
}
function fillLookupOptions() {
  // No datalist: its native popup duplicated the department code and cannot
  // be styled or reliably navigated by keyboard across browsers.
  hideLookup("department");
  hideLookup("room");
  updateLookupValue("department");
  updateLookupValue("room");
}
function installLookup(kind) {
  const {input,field}=lookupParts(kind);
  const toggle=kind==="department" ? $("#departmentLookupToggle") : $("#roomLookupToggle");
  input.addEventListener("focus",()=>showLookup(kind));
  input.addEventListener("input",()=>{
    if(lookupParts(kind).select.value) {
      lookupParts(kind).select.value="";
      if(kind==="department") {
        selectedGrades.clear();
        $("#classSelect").value="";
        refreshLinkedOptions();
      }
      queueSearch();
    }
    showLookup(kind);
  });
  input.addEventListener("keydown",(event)=>{
    if(event.key==="ArrowDown" || event.key==="ArrowUp") {
      event.preventDefault();
      if(!lookupState[kind].open)showLookup(kind);
      const state=lookupState[kind];
      highlightLookup(kind,state.activeIndex+(event.key==="ArrowDown"?1:-1));
    } else if(event.key==="Enter" && lookupState[kind].open) {
      event.preventDefault();
      const state=lookupState[kind];
      let item=state.choices[state.activeIndex];
      if(!item) {
        const query=input.value.trim().toLowerCase();
        item=state.choices.find((choice)=>choice.value && [
          String(choice.value).toLowerCase(),String(choice.displayLabel).toLowerCase()
        ].includes(query));
      }
      if(item)chooseLookup(kind,item);
    } else if(event.key==="Escape" && lookupState[kind].open) {
      event.preventDefault();
      hideLookup(kind,{restore:true});
    }
  });
  toggle.addEventListener("click",()=>{
    const isOpen=lookupState[kind].open;
    if(isOpen)hideLookup(kind,{restore:true});
    else {input.focus();showLookup(kind,{browse:true});}
  });
  input.addEventListener("blur",()=>{
    // Delay is unnecessary: option pointerdown retains focus until click.
    if(!field.contains(document.activeElement))hideLookup(kind,{restore:true});
  });
}
for(const kind of ["department","room"])installLookup(kind);
document.addEventListener("pointerdown",(event)=>{
  for(const kind of ["department","room"]) {
    if(!lookupParts(kind).field.contains(event.target))hideLookup(kind,{restore:true});
  }
});

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
    let gradesChanged = false;
    for (const grade of [...selectedGrades]) {
      if (!allowedGrades.has(grade)) { selectedGrades.delete(grade); gradesChanged = true; }
    }
    renderGradeChips();
    if (gradesChanged) { refreshLinkedOptions(); queueSearch(); return; }
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
    teacher: "#teacherInput", class_group: "#classSelect", time_of_day: "#timeOfDaySelect", schedule: "#scheduleSelect",
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
  const minCredits = params.get("min_credits"), maxCredits = params.get("max_credits");
  if (minCredits && minCredits === maxCredits && [...$("#creditsSelect").options].some((opt) => opt.value === minCredits)) {
    $("#creditsSelect").value = minCredits;
  }
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
  ensureStateTerm();
  updateScheduleCount();
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
// Removable shortcuts for the filters most frequently changed while planning.
function renderActiveFilterChips() {
  const root = $("#activeFilterChips");
  root.replaceChildren();
  const chips = [
    ...[["#departmentSelect", "系所"],["#classSelect", "班級"],["#divisionSelect", "部別"],
      ["#studyLevelSelect", "學制"],["#creditsSelect", "學分"],["#reqSelect", "必／選修"],
      ["#roomSelect", "教室"],["#sectionSelect", "節次"]]
      .filter(([selector]) => Boolean($(selector).value))
      .map(([selector, label]) => {
        const item = $(selector).selectedOptions[0];
        const display = selector === "#departmentSelect" ? $("#departmentLookup").value
          : selector === "#roomSelect" ? $("#roomLookup").value
          : item?.textContent?.replace(/（\d+）$/, "") || $(selector).value;
        return { label: `${label}：${display}`, clear() {
          $(selector).value = "";
          if (selector === "#departmentSelect") {
            $("#departmentLookup").value = "";
            selectedGrades.clear(); renderGradeChips();
            $("#classSelect").value = "";
            refreshLinkedOptions();
          }
          if (selector === "#roomSelect") $("#roomLookup").value = "";
          if (["#studyLevelSelect","#divisionSelect"].includes(selector)) refreshLinkedOptions();
        } };
      }),
    ...(selectedGrades.size ? [{label:`年級：${[...selectedGrades].join("、")}`,clear() {
      selectedGrades.clear();renderGradeChips();refreshLinkedOptions();
    }}] : []),
    ...(selectedWeekdays.size ? [{label:`星期：${[...selectedWeekdays].sort().map(x=>weekdayNames[Number(x)]).join("、")}`,clear() {
      selectedWeekdays.clear();renderWeekdayChips();
    }}] : []),
    ...(avoidConflicts ? [{label:"避免衝堂",clear() { avoidConflicts=false; }}] : []),
  ];
  for (const chip of chips) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "active-filter-chip";
    button.textContent = chip.label + " ×";
    button.setAttribute("aria-label", "移除篩選：" + chip.label);
    button.addEventListener("click", () => { chip.clear(); search({resetPage:true}); });
    root.append(button);
  }
}

function updateFilterSummary() {
  const parts = []; const mappings = [["#departmentSelect", "系所"], ["#sectionSelect", "節次"], ["#roomSelect", "教室"], ["#creditsSelect", "學分"], ["#reqSelect", "必選修"], ["#divisionSelect", "部別"], ["#studyLevelSelect", "層級"], ["#courseTagSelect", "標籤"], ["#teacherInput", "教師"], ["#classSelect", "班別"], ["#teachingLanguageSelect", "授課語言"], ["#materialLanguageSelect", "教材語言"], ["#teachingMethodSelect", "教學方式"], ["#assessmentSelect", "評量方式"], ["#relationSelect", "能力／議題"], ["#prerequisiteInput", "先修"]];
  for (const [selector, label] of mappings) { const node = $(selector); if (!node?.value) continue; const text = node.tagName === "SELECT" ? node.selectedOptions[0].textContent.replace(/（\d+）$/, "") : node.value; parts.push(`${label}：${text}`); }
  if (selectedGrades.size) parts.push(`年級：${[...selectedGrades].sort().join("、")}`);
  if (selectedWeekdays.size) parts.push(`星期：${[...selectedWeekdays].sort().map((value) => weekdayNames[Number(value)]).join("、")}`);
  if ($("#timeOfDaySelect").value !== "all") parts.push(`時段：${$("#timeOfDaySelect").selectedOptions[0].textContent}`); if ($("#scheduleSelect").value !== "all") parts.push($("#scheduleSelect").selectedOptions[0].textContent);
  if ($("#assessmentStyleSelect").value !== "all") parts.push(`評量類型：${$("#assessmentStyleSelect").selectedOptions[0].textContent}`); if ($("#onlineTeachingSelect").value !== "all") parts.push(`線上：${$("#onlineTeachingSelect").selectedOptions[0].textContent}`); if ($("#detailIndexedSelect").value !== "all") parts.push($("#detailIndexedSelect").selectedOptions[0].textContent); if (selectedSections.size) parts.push(`精確節次：${[...selectedSections].join("、")}`);
  if (avoidConflicts) parts.push("避開衝堂");
  $("#activeFilterText").textContent = parts.length ? `已套用 ${parts.length} 項條件` : "目前未套用篩選條件";
  renderActiveFilterChips();
  const advancedNodes = ["#courseTagSelect", "#teacherInput", "#teachingLanguageSelect", "#materialLanguageSelect", "#teachingMethodSelect", "#assessmentSelect", "#relationSelect", "#prerequisiteInput"];
  let count = advancedNodes.filter((selector) => $(selector).value).length + selectedSections.size + Number($("#timeOfDaySelect").value !== "all") + Number($("#scheduleSelect").value !== "all") + Number($("#assessmentStyleSelect").value !== "all") + Number($("#onlineTeachingSelect").value !== "all") + Number($("#detailIndexedSelect").value !== "all"); $("#advancedCount").textContent = count;
}

function matchesFavoriteFilters(course, params) {
  const query = (params.get("q") || "").toLocaleLowerCase().trim();
  const haystack = [course.name, course.name_en, course.course_code,
    course.teacher, course.department].join(" ").toLocaleLowerCase();
  if (query && !query.split(/\s+/).every((word) => haystack.includes(word))) return false;
  const department = params.get("department");
  if (department && course.department_code !== department && course.department !== department) return false;
  const grades = new Set((params.get("grades") || params.get("grade") || "").split(",").map(Number).filter(Boolean));
  if (grades.size && !grades.has(Number(course.grade))) return false;
  const classGroup = params.get("class_group");
  if (classGroup && !(course.class_group || "").includes(classGroup)) return false;
  if (params.get("division") && course.division !== params.get("division")) return false;
  if (params.get("study_level") && course.study_level !== params.get("study_level")) return false;
  const selectedDays = new Set((params.get("weekdays") || params.get("weekday") || "").split(",").map(Number).filter(Boolean));
  const requestedSections = new Set((params.get("sections") || "").split(",").filter(Boolean));
  if (params.get("section")) requestedSections.add(params.get("section"));
  if ((selectedDays.size || requestedSections.size) && !(course.meetings || []).some((meeting) =>
    (!selectedDays.size || selectedDays.has(meeting.weekday))
    && (!requestedSections.size || (meeting.sections || []).some((section) => requestedSections.has(section)))
  )) return false;
  const room = params.get("room");
  if (room && !(course.meetings || []).some((meeting) => meeting.room === room)) return false;
  const credits = params.get("min_credits");
  if (credits !== null && Number(course.credits_number) !== Number(credits)) return false;
  if (params.get("required_elective") && course.required_elective !== params.get("required_elective")) return false;
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
  if (!currentCourses.length) {
    const empty = document.createElement("div"); empty.className = "panel empty-result";
    const title = document.createElement("strong");
    title.textContent = viewMode === "favorites" ? "還沒有符合條件的收藏" : "找不到符合條件的課程";
    const tip = document.createElement("span");
    tip.textContent = "試著放寬星期、年級或系所條件，讓搜尋範圍更大。";
    const reset = document.createElement("button");
    reset.type = "button"; reset.className = "secondary";
    reset.textContent = "清除篩選，再找一次";
    reset.addEventListener("click", () => resetFilters());
    empty.append(title, tip, reset); root.append(empty); return;
  }
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
    node.querySelector(".req-badge").textContent = course.required_elective || "未標示";
    const indexBadge = node.querySelector(".index-badge");
    indexBadge.textContent = course.detail_indexed ? "課綱已同步" : "課綱待同步";
    indexBadge.classList.add(course.detail_indexed ? "fit-badge" : "neutral-badge");
    node.querySelector(".course-meta").textContent = [
      course.course_code, course.department,
      course.grade ? `${course.grade} 年級` : "",
      course.division,
    ].filter(Boolean).join(" · ");
    node.querySelector(".course-teacher").textContent = course.teacher || "未提供";
    node.querySelector(".course-class-label").textContent = course.class_group || "";
    node.querySelector(".course-credits").textContent = course.credits_number != null ? String(course.credits_number) : "—";
    node.querySelector(".meeting-text").textContent = meetingLabel(course);
    const tagsRoot = node.querySelector(".course-tags");
    for (const tag of (course.course_tags || []).slice(0, 3)) {
      const span = document.createElement("span");
      span.className = "course-tag";
      span.textContent = tag.label;
      tagsRoot.append(span);
    }
    const mobileMeta = document.createElement("p");
    mobileMeta.className = "course-mobile-meta";
    mobileMeta.textContent = [course.teacher, course.class_group, course.credits_number != null ? `${course.credits_number} 學分` : ""].filter(Boolean).join(" · ");
    node.querySelector(".course-main").append(mobileMeta);
    node.querySelector(".outline-link").href = course.outline_url;
    const detailButton = node.querySelector(".detail-btn");
    const staticUnindexed = Boolean(meta?.pages_mode && !course.detail_indexed);
    detailButton.textContent = staticUnindexed ? "資料待同步" : "查看詳情";
    detailButton.disabled = staticUnindexed;
    detailButton.title = staticUnindexed ? "此課尚未完成 GitHub Pages 詳細索引，請先查看官方課綱" : "";
    if (!staticUnindexed) detailButton.addEventListener("click", () => showDetail(course));
    const button = node.querySelector(".add-btn"); const exists = selectedCourses().some((item) => item.id === course.id); button.textContent = exists ? "✓ 已加入" : "＋ 加入課表"; button.disabled = exists; button.addEventListener("click", () => addCourse(course)); root.append(node);
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
  $("#detailDialog").showModal();
  $("#detailTitle").textContent = course.name;
  const officialLink = $("#detailOfficialLink");
  if (course.outline_url) { officialLink.href = course.outline_url; officialLink.classList.remove("hidden"); }
  else { officialLink.removeAttribute("href"); officialLink.classList.add("hidden"); }
  $("#detailContent").innerHTML = '<div class="status">正在載入課程資料…</div>';
  try { const response = await fetch(`/api/course/${encodeURIComponent(course.id)}`); const detail = await response.json(); if (!response.ok) throw new Error(detail.detail || "完整資料載入失敗"); renderDetail(detail); if (!course.detail_indexed) { await loadMetaAndFacets({ preserveValues: true }); await search({ updateUrl: false }); } }
  catch (error) { $("#detailContent").innerHTML = `<div class="status">${escapeHtml(error.message)}</div>`; }
}
function resetFilters({ searchNow = true } = {}) {
  for (const selector of ["#searchInput", "#teacherInput", "#prerequisiteInput", "#departmentLookup", "#roomLookup"]) $(selector).value = "";
  for (const selector of ["#departmentSelect", "#weekdaySelect", "#sectionSelect", "#roomSelect", "#creditsSelect", "#reqSelect", "#divisionSelect", "#gradeSelect", "#studyLevelSelect", "#courseTagSelect", "#classSelect", "#teachingLanguageSelect", "#materialLanguageSelect", "#teachingMethodSelect", "#assessmentSelect", "#relationSelect"]) $(selector).value = "";
  for (const selector of ["#timeOfDaySelect", "#scheduleSelect", "#assessmentStyleSelect", "#onlineTeachingSelect", "#detailIndexedSelect"]) $(selector).value = "all";
  $("#sortSelect").value = "relevance"; $("#teachingMethodCriterionSelect").value = "dominant"; $("#assessmentCriterionSelect").value = "dominant"; $("#teachingMethodMinInput").value = "20"; $("#assessmentMinInput").value = "20"; selectedSections.clear(); selectedGrades.clear(); selectedWeekdays.clear();
  avoidConflicts = false; linkedOptions = null;
  renderSectionChips(); renderGradeChips(); renderWeekdayChips();
  refreshLinkedOptions();
  if (searchNow) search({ resetPage: true });
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
const desktopQuery = window.matchMedia("(min-width: 1121px)");
desktopQuery.addEventListener("change", (event) => {
  if (event.matches) setFilterPanelOpen(false, { restoreFocus: false });
});

// Update results as soon as filters change; do not require a separate Apply click.
for (const select of document.querySelectorAll(".search-panel select:not([hidden])")) {
  select.addEventListener("change", () => {
    if (["divisionSelect", "studyLevelSelect"].includes(select.id)) {
      $("#classSelect").value = "";
      refreshLinkedOptions();
    }
    queueSearch();
  });
}
for (const selector of ["#teacherInput", "#prerequisiteInput"]) {
  $(selector).addEventListener("input", () => queueSearch(350));
}
$("#searchInput").addEventListener("input", () => queueSearch(350));
$("#guideSearchBtn").addEventListener("click", () => {
  $("#searchInput").scrollIntoView({behavior:"smooth",block:"center"});
  $("#searchInput").focus();
});
$("#guideFilterBtn").addEventListener("click", () => {
  if (window.matchMedia("(max-width: 1120px)").matches) setFilterPanelOpen(true);
  else {
    $("#filterPanel").scrollIntoView({behavior:"smooth",block:"nearest"});
    $("#departmentLookup").focus();
  }
});
$("#guideScheduleBtn").addEventListener("click", openSchedule);
$("#openPlannerBtn").addEventListener("click", openSchedule);
$("#openComparisonBtn").addEventListener("click", openSchedule);
$("#clearResultsFiltersBtn").addEventListener("click", () => resetFilters());
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
