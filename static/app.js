const $ = (selector) => document.querySelector(selector);
const weekdays = ["", "一", "二", "三", "四", "五", "六", "日"];
const stateKey = "fju-course-liteplus:state";
const preferenceKey = "fju-course-liteplus:preferences";
const legacyKey = "fju-course-lite:selected";

const sectionTimes = {
  D1: ["08:10", "09:00"], D2: ["09:10", "10:00"], D3: ["10:10", "11:00"], D4: ["11:10", "12:00"],
  DN: ["12:40", "13:30"], D5: ["13:40", "14:30"], D6: ["14:40", "15:30"], D7: ["15:40", "16:30"],
  D8: ["16:40", "17:30"], E0: ["17:40", "18:30"], E1: ["18:40", "19:30"], E2: ["19:35", "20:20"],
  E3: ["20:30", "21:20"], E4: ["21:25", "22:10"],
};
const sectionOrder = Object.keys(sectionTimes);
const sectionRank = new Map(sectionOrder.map((section, index) => [section, index]));

let meta = null;
let currentCourses = [];
let currentPage = 1;
let totalPages = 1;
let totalResults = 0;
let state = loadState();
let preferences = loadPreferences();

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

function loadPreferences() {
  const fallback = { avoidEarly: false, avoidFriday: false, compact: true, preferredTeacher: "", recommendMode: true };
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(preferenceKey) || "{}") }; }
  catch { return fallback; }
}

function saveState() {
  localStorage.setItem(stateKey, JSON.stringify(state));
}

function savePreferences() {
  localStorage.setItem(preferenceKey, JSON.stringify(preferences));
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

function meetingLabel(course) {
  if (!course.meetings?.length) return "時間未提供";
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

function findConflicts(course) {
  return selectedCourses().filter((item) => item.id !== course.id && conflict(item, course));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[char]));
}

function scoreCourse(course) {
  let score = 50;
  const reasons = [];
  const conflicts = findConflicts(course);
  if (conflicts.length) {
    score -= 100;
    reasons.push(`與 ${conflicts.map((item) => item.name).join("、")} 衝堂`);
  }

  if (!course.meetings?.length) {
    score -= 8;
    reasons.push("上課時間未提供");
  }

  if (preferences.avoidEarly && (course.meetings || []).some((meeting) => (meeting.sections || []).includes("D1"))) {
    score -= 12;
    reasons.push("含 D1 早八");
  }

  if (preferences.avoidFriday && (course.meetings || []).some((meeting) => meeting.weekday === 5)) {
    score -= 10;
    reasons.push("星期五有課");
  }

  const preferredTeacher = preferences.preferredTeacher.trim().toLocaleLowerCase();
  if (preferredTeacher && course.teacher?.toLocaleLowerCase().includes(preferredTeacher)) {
    score += 12;
    reasons.push("符合偏好教師");
  }

  if (preferences.compact && selectedCourses().length && course.meetings?.length) {
    let adjacent = false;
    let sameDay = false;
    for (const meeting of course.meetings) {
      const candidateIndexes = (meeting.sections || []).map((section) => sectionRank.get(section)).filter((index) => index !== undefined);
      for (const existing of selectedCourses()) {
        for (const existingMeeting of existing.meetings || []) {
          if (existingMeeting.weekday !== meeting.weekday) continue;
          sameDay = true;
          const existingIndexes = (existingMeeting.sections || []).map((section) => sectionRank.get(section)).filter((index) => index !== undefined);
          if (candidateIndexes.some((a) => existingIndexes.some((b) => Math.abs(a - b) === 1))) adjacent = true;
        }
      }
    }
    if (adjacent) {
      score += 8;
      reasons.push("可接續既有課程，較少空堂");
    } else if (sameDay) {
      score += 3;
      reasons.push("集中在已有上課日");
    }
  }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

function addCourse(course) {
  const courses = selectedCourses();
  if (courses.some((item) => item.id === course.id)) return;

  const sameCode = course.course_code && courses.find((item) => item.course_code === course.course_code);
  if (sameCode && !window.confirm(`課號 ${course.course_code} 已有「${sameCode.name}」。仍要加入目前方案嗎？`)) return;

  const conflicts = findConflicts(course);
  if (conflicts.length) {
    showConflict(`衝堂：${course.name} 與 ${conflicts.map((item) => item.name).join("、")}`);
    return;
  }

  hideConflict();
  courses.push(course);
  saveState();
  renderAllScheduleViews();
  renderCourses();
}

function removeCourse(id) {
  activePlan().courses = selectedCourses().filter((item) => item.id !== id);
  saveState();
  renderAllScheduleViews();
  renderCourses();
}

function showConflict(message) {
  $("#conflictBox").textContent = message;
  $("#conflictBox").classList.remove("hidden");
}

function hideConflict() {
  $("#conflictBox").classList.add("hidden");
}

function renderPlanSelector() {
  const select = $("#planSelect");
  select.replaceChildren();
  for (const plan of state.plans) {
    const option = document.createElement("option");
    option.value = plan.id;
    option.textContent = plan.name;
    option.selected = plan.id === state.activePlanId;
    select.append(option);
  }
}

function renderSelected() {
  const root = $("#selectedList");
  root.replaceChildren();
  const courses = selectedCourses();
  const credits = courses.reduce((sum, course) => sum + (Number(course.credits_number ?? course.credits) || 0), 0);
  const creditText = Number.isInteger(credits) ? String(credits) : credits.toFixed(1).replace(/\.0$/, "");
  $("#planSummary").textContent = `${courses.length} 門｜約 ${creditText} 學分`;

  if (!courses.length) {
    root.innerHTML = '<p class="empty">尚未加入課程。</p>';
    return;
  }

  for (const course of courses) {
    const item = document.createElement("div");
    item.className = "selected-item";
    item.innerHTML = `<div><strong>${escapeHtml(course.name)}</strong><div class="small muted">${escapeHtml(meetingLabel(course))}</div></div>`;
    const button = document.createElement("button");
    button.className = "text-btn danger";
    button.textContent = "移除";
    button.addEventListener("click", () => removeCourse(course.id));
    item.append(button);
    root.append(item);
  }
}

function renderTimetable() {
  const wrap = $("#timetableWrap");
  const table = document.createElement("table");
  table.className = "timetable";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.innerHTML = "<th>節次</th>";
  for (let day = 1; day <= 7; day += 1) {
    const th = document.createElement("th");
    th.textContent = `週${weekdays[day]}`;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const section of sectionOrder) {
    const row = document.createElement("tr");
    const sectionCell = document.createElement("th");
    sectionCell.innerHTML = `<strong>${section}</strong><span>${sectionTimes[section][0]}</span>`;
    row.append(sectionCell);

    for (let day = 1; day <= 7; day += 1) {
      const cell = document.createElement("td");
      const courses = selectedCourses().filter((course) =>
        (course.meetings || []).some((meeting) => meeting.weekday === day && (meeting.sections || []).includes(section))
      );
      if (courses.length > 1) cell.classList.add("conflict-cell");
      for (const course of courses) {
        const chip = document.createElement("button");
        chip.className = "timetable-course";
        chip.type = "button";
        chip.title = `${course.name}\n${meetingLabel(course)}`;
        chip.textContent = course.name;
        chip.addEventListener("click", () => removeCourse(course.id));
        cell.append(chip);
      }
      row.append(cell);
    }
    tbody.append(row);
  }
  table.append(tbody);
  wrap.replaceChildren(table);
}

function renderCourses() {
  const root = $("#courseList");
  root.replaceChildren();
  const template = $("#courseTemplate");
  const courses = currentCourses.map((course) => ({ course, recommendation: scoreCourse(course) }));
  if (preferences.recommendMode) courses.sort((a, b) => b.recommendation.score - a.recommendation.score || a.course.name.localeCompare(b.course.name, "zh-Hant"));

  for (const { course, recommendation } of courses) {
    const node = template.content.cloneNode(true);
    node.querySelector(".course-name").textContent = course.name;
    node.querySelector(".req-badge").textContent = course.required_elective || "未標示";
    node.querySelector(".course-meta").textContent = [
      course.course_code,
      course.teacher,
      course.credits !== null && course.credits !== "" ? `${course.credits} 學分` : "",
      course.department,
      course.class_group,
    ].filter(Boolean).join("｜");
    node.querySelector(".meeting-text").textContent = meetingLabel(course);

    const scoreBadge = node.querySelector(".score-badge");
    const reason = node.querySelector(".recommend-reason");
    if (preferences.recommendMode) {
      scoreBadge.textContent = `規則 ${recommendation.score}`;
      scoreBadge.classList.remove("hidden");
      reason.textContent = recommendation.reasons.length ? recommendation.reasons.join("；") : "沒有觸發加減分條件";
      reason.classList.remove("hidden");
    }

    const link = node.querySelector(".outline-link");
    link.href = course.outline_url;
    const button = node.querySelector(".add-btn");
    const exists = selectedCourses().some((item) => item.id === course.id);
    const conflicts = findConflicts(course);
    button.textContent = exists ? "已加入" : conflicts.length ? "會衝堂" : "加入課表";
    button.disabled = exists;
    if (conflicts.length && !exists) button.classList.add("warning-btn");
    button.addEventListener("click", () => addCourse(course));
    root.append(node);
  }
}

function renderPager() {
  $("#resultCount").textContent = `共 ${totalResults} 門｜本頁 ${currentCourses.length} 門${preferences.recommendMode ? "｜本頁依規則分數排序" : ""}`;
  $("#pageText").textContent = `${currentPage} / ${totalPages}`;
  $("#prevPageBtn").disabled = currentPage <= 1;
  $("#nextPageBtn").disabled = currentPage >= totalPages;
}

function renderAllScheduleViews() {
  renderPlanSelector();
  renderSelected();
  renderTimetable();
}

function applyPreferenceControls() {
  $("#avoidEarlyCheck").checked = preferences.avoidEarly;
  $("#avoidFridayCheck").checked = preferences.avoidFriday;
  $("#compactCheck").checked = preferences.compact;
  $("#preferredTeacherInput").value = preferences.preferredTeacher;
  $("#recommendMode").checked = preferences.recommendMode;
}

function readPreferencesFromControls() {
  preferences = {
    avoidEarly: $("#avoidEarlyCheck").checked,
    avoidFriday: $("#avoidFridayCheck").checked,
    compact: $("#compactCheck").checked,
    preferredTeacher: $("#preferredTeacherInput").value,
    recommendMode: $("#recommendMode").checked,
  };
  savePreferences();
  renderCourses();
  renderPager();
}

async function loadMeta() {
  const response = await fetch("/api/meta");
  meta = await response.json();
  $("#termText").textContent = `資料來源：輔仁大學公開課程大綱 API｜${meta.academic_year} 學年度第 ${meta.semester} 學期`;
}

function buildSearchParams() {
  const params = new URLSearchParams({ page: String(currentPage), page_size: "30", sort: $("#sortSelect").value });
  const mappings = [
    ["q", "#searchInput"], ["teacher", "#teacherInput"], ["department", "#departmentInput"], ["class_group", "#classInput"],
    ["weekday", "#weekdaySelect"], ["section", "#sectionInput"], ["required_elective", "#reqSelect"],
    ["min_credits", "#minCreditsInput"], ["max_credits", "#maxCreditsInput"],
  ];
  for (const [key, selector] of mappings) {
    const value = $(selector).value.trim();
    if (value) params.set(key, value);
  }
  if ($("#timedOnlyCheck").checked) params.set("timed_only", "true");
  return params;
}

async function search({ resetPage = false } = {}) {
  if (resetPage) currentPage = 1;
  $("#status").textContent = "載入中…";
  $("#status").classList.remove("hidden");
  try {
    const response = await fetch(`/api/courses?${buildSearchParams()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "讀取失敗");
    currentCourses = data.items;
    totalResults = data.total;
    currentPage = data.page;
    totalPages = data.total_pages;
    $("#status").classList.add("hidden");
    renderCourses();
    renderPager();
  } catch (error) {
    $("#status").textContent = error.message;
    currentCourses = [];
    totalResults = 0;
    renderCourses();
    renderPager();
  }
}

function resetFilters() {
  for (const selector of ["#searchInput", "#teacherInput", "#departmentInput", "#classInput", "#sectionInput", "#minCreditsInput", "#maxCreditsInput"]) {
    $(selector).value = "";
  }
  $("#weekdaySelect").value = "";
  $("#reqSelect").value = "";
  $("#sortSelect").value = "name";
  $("#timedOnlyCheck").checked = false;
  search({ resetPage: true });
}

function downloadText(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCsv() {
  const rows = [["課號", "課名", "教師", "學分", "必選修", "系所", "班別", "星期", "節次", "教室"]];
  for (const course of selectedCourses()) {
    if (!course.meetings?.length) {
      rows.push([course.course_code, course.name, course.teacher, course.credits, course.required_elective, course.department, course.class_group, "", "", ""]);
      continue;
    }
    for (const meeting of course.meetings) {
      rows.push([course.course_code, course.name, course.teacher, course.credits, course.required_elective, course.department, course.class_group, weekdays[meeting.weekday] || "", (meeting.sections || []).join(","), meeting.room]);
    }
  }
  downloadText(`${activePlan().name}.csv`, `\ufeff${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`, "text/csv;charset=utf-8");
}

function pad2(value) { return String(value).padStart(2, "0"); }
function icsDate(date) { return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`; }
function icsEscape(value) { return String(value ?? "").replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,").replaceAll("\n", "\\n"); }

function contiguousGroups(sections) {
  const known = [...new Set(sections.filter((section) => sectionRank.has(section)))].sort((a, b) => sectionRank.get(a) - sectionRank.get(b));
  const groups = [];
  for (const section of known) {
    const last = groups.at(-1);
    if (!last || sectionRank.get(section) !== sectionRank.get(last.at(-1)) + 1) groups.push([section]);
    else last.push(section);
  }
  return groups;
}

function exportIcs() {
  if (!meta?.semester_start) {
    alert("未設定學期開始日期，無法匯出 ICS。");
    return;
  }
  const semesterMonday = new Date(`${meta.semester_start}T00:00:00`);
  if (Number.isNaN(semesterMonday.getTime())) {
    alert("學期開始日期格式錯誤。");
    return;
  }

  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//FJU Course Recommender Lite+//ZH-TW", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const course of selectedCourses()) {
    for (const meeting of course.meetings || []) {
      if (!meeting.weekday) continue;
      for (const group of contiguousGroups(meeting.sections || [])) {
        const first = group[0];
        const last = group.at(-1);
        const [startTime] = sectionTimes[first];
        const [, endTime] = sectionTimes[last];
        const date = new Date(semesterMonday);
        date.setDate(date.getDate() + meeting.weekday - 1);
        const datePart = icsDate(date);
        const start = `${datePart}T${startTime.replace(":", "")}00`;
        const end = `${datePart}T${endTime.replace(":", "")}00`;
        lines.push(
          "BEGIN:VEVENT",
          `UID:${icsEscape(`${course.id}-${meeting.weekday}-${first}@fju-course-lite`)}`,
          `DTSTART;TZID=Asia/Taipei:${start}`,
          `DTEND;TZID=Asia/Taipei:${end}`,
          `RRULE:FREQ=WEEKLY;COUNT=${meta.semester_weeks || 18}`,
          `SUMMARY:${icsEscape(course.name)}`,
          `LOCATION:${icsEscape(meeting.room || "")}`,
          `DESCRIPTION:${icsEscape([course.teacher, course.course_code, course.outline_url].filter(Boolean).join("｜"))}`,
          "END:VEVENT",
        );
      }
    }
  }
  lines.push("END:VCALENDAR");
  downloadText(`${activePlan().name}.ics`, lines.join("\r\n"), "text/calendar;charset=utf-8");
}

async function copyPlanText() {
  const lines = [`${activePlan().name}（${selectedCourses().length} 門）`];
  for (const course of selectedCourses()) lines.push(`- ${course.name}｜${course.teacher || "教師未定"}｜${meetingLabel(course)}`);
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    $("#copyPlanBtn").textContent = "已複製";
    setTimeout(() => { $("#copyPlanBtn").textContent = "複製文字"; }, 1200);
  } catch {
    alert("瀏覽器未允許剪貼簿權限。");
  }
}

$("#searchBtn").addEventListener("click", () => search({ resetPage: true }));
$("#resetFiltersBtn").addEventListener("click", resetFilters);
$("#searchInput").addEventListener("keydown", (event) => { if (event.key === "Enter") search({ resetPage: true }); });
$("#prevPageBtn").addEventListener("click", () => { if (currentPage > 1) { currentPage -= 1; search(); } });
$("#nextPageBtn").addEventListener("click", () => { if (currentPage < totalPages) { currentPage += 1; search(); } });

for (const selector of ["#avoidEarlyCheck", "#avoidFridayCheck", "#compactCheck", "#preferredTeacherInput", "#recommendMode"]) {
  $(selector).addEventListener(selector === "#preferredTeacherInput" ? "input" : "change", readPreferencesFromControls);
}

$("#planSelect").addEventListener("change", (event) => {
  state.activePlanId = event.target.value;
  saveState();
  hideConflict();
  renderAllScheduleViews();
  renderCourses();
});

$("#newPlanBtn").addEventListener("click", () => {
  const name = window.prompt("新方案名稱", `方案 ${String.fromCharCode(65 + state.plans.length)}`)?.trim();
  if (!name) return;
  const id = makeId();
  state.plans.push({ id, name, courses: [] });
  state.activePlanId = id;
  saveState();
  renderAllScheduleViews();
  renderCourses();
});

$("#renamePlanBtn").addEventListener("click", () => {
  const plan = activePlan();
  const name = window.prompt("方案名稱", plan.name)?.trim();
  if (!name) return;
  plan.name = name;
  saveState();
  renderAllScheduleViews();
});

$("#deletePlanBtn").addEventListener("click", () => {
  if (state.plans.length === 1) {
    alert("至少保留一個課表方案。");
    return;
  }
  const plan = activePlan();
  if (!window.confirm(`刪除「${plan.name}」？`)) return;
  state.plans = state.plans.filter((item) => item.id !== plan.id);
  state.activePlanId = state.plans[0].id;
  saveState();
  renderAllScheduleViews();
  renderCourses();
});

$("#clearBtn").addEventListener("click", () => {
  if (selectedCourses().length && !window.confirm(`清空「${activePlan().name}」？`)) return;
  activePlan().courses = [];
  saveState();
  hideConflict();
  renderAllScheduleViews();
  renderCourses();
});

$("#copyPlanBtn").addEventListener("click", copyPlanText);
$("#csvBtn").addEventListener("click", exportCsv);
$("#icsBtn").addEventListener("click", exportIcs);

$("#refreshBtn").addEventListener("click", async () => {
  const button = $("#refreshBtn");
  button.disabled = true;
  button.textContent = "更新中…";
  try {
    const response = await fetch("/api/refresh", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "更新失敗");
    await search({ resetPage: true });
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "重新抓取課程";
  }
});

applyPreferenceControls();
renderAllScheduleViews();
await loadMeta();
await search({ resetPage: true });
