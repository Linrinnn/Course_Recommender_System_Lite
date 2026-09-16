const $ = (selector) => document.querySelector(selector);
const weekdays = ["", "一", "二", "三", "四", "五", "六", "日"];
const stateKey = "fju-course-liteplus:state";
const sectionTimes = {
  D0: ["07:10", "08:00"], D1: ["08:10", "09:00"], D2: ["09:10", "10:00"], D3: ["10:10", "11:00"],
  D4: ["11:10", "12:00"], DN: ["12:40", "13:30"], D5: ["13:40", "14:30"], D6: ["14:40", "15:30"],
  D7: ["15:40", "16:30"], D8: ["16:40", "17:30"], E0: ["17:40", "18:30"], E1: ["18:40", "19:30"],
  E2: ["19:35", "20:20"], E3: ["20:30", "21:20"], E4: ["21:25", "22:10"],
};
const sectionOrder = Object.keys(sectionTimes);
let meta = null;
let state = loadState();
let slot = null;
let slotPage = 1;
let slotTotalPages = 1;
let slotCourses = [];

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(stateKey) || "null");
    if (parsed?.plans?.length && parsed.activePlanId) return parsed;
  } catch {}
  const id = makeId();
  return { activePlanId: id, plans: [{ id, name: "方案 A", courses: [] }] };
}

function saveState() {
  localStorage.setItem(stateKey, JSON.stringify(state));
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

function courses() {
  return activePlan().courses;
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
      const sectionsA = new Set(ma.sections || []);
      if ((mb.sections || []).some((section) => sectionsA.has(section))) return true;
    }
  }
  return false;
}

function conflictsFor(course) {
  return courses().filter((existing) => existing.id !== course.id && conflict(existing, course));
}

function renderPlanControls() {
  const select = $("#planSelect");
  select.replaceChildren();
  for (const plan of state.plans) {
    const option = new Option(plan.name, plan.id, plan.id === state.activePlanId, plan.id === state.activePlanId);
    select.append(option);
  }
  const credits = courses().reduce((sum, course) => sum + (Number(course.credits_number ?? course.credits) || 0), 0);
  $("#planSummary").textContent = `${courses().length} 門｜${Number.isInteger(credits) ? credits : credits.toFixed(1)} 學分`;
}

function renderTimetable() {
  const table = document.createElement("table");
  table.className = "timetable";
  const thead = document.createElement("thead");
  const header = document.createElement("tr");
  header.innerHTML = "<th>節次</th>";
  for (let day = 1; day <= 7; day += 1) {
    const th = document.createElement("th");
    th.textContent = `星期${weekdays[day]}`;
    header.append(th);
  }
  thead.append(header);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const section of sectionOrder) {
    const row = document.createElement("tr");
    const label = document.createElement("th");
    label.innerHTML = `<strong>${section}</strong><span>${sectionTimes[section][0]}</span>`;
    row.append(label);
    for (let day = 1; day <= 7; day += 1) {
      const cell = document.createElement("td");
      cell.className = "schedule-slot-cell";
      const occupants = courses().filter((course) =>
        (course.meetings || []).some((meeting) => meeting.weekday === day && (meeting.sections || []).includes(section))
      );
      if (occupants.length > 1) cell.classList.add("conflict-cell");
      for (const course of occupants) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "timetable-course";
        chip.textContent = course.name;
        chip.title = `${course.name}\n${meetingLabel(course)}`;
        chip.addEventListener("click", (event) => {
          event.stopPropagation();
          openSlot(day, section);
        });
        cell.append(chip);
      }
      const searchButton = document.createElement("button");
      searchButton.type = "button";
      searchButton.className = occupants.length ? "slot-search-mini" : "slot-search-button";
      searchButton.textContent = occupants.length ? "找同節次其他課" : "搜尋此節次";
      searchButton.addEventListener("click", (event) => {
        event.stopPropagation();
        openSlot(day, section);
      });
      cell.append(searchButton);
      cell.addEventListener("click", () => openSlot(day, section));
      row.append(cell);
    }
    tbody.append(row);
  }
  table.append(tbody);
  $("#timetableWrap").replaceChildren(table);
}

function renderAll() {
  renderPlanControls();
  renderTimetable();
}

async function openSlot(weekday, section) {
  slot = { weekday, section };
  slotPage = 1;
  $("#slotSearchPanel").classList.remove("hidden");
  $("#slotTitle").textContent = `星期${weekdays[weekday]} ${section} 的課程`;
  $("#slotSubtitle").textContent = "只列出包含這個星期與節次的課。加入前會檢查目前方案的衝堂。";
  $("#slotKeyword").value = "";
  await searchSlot();
  $("#slotSearchPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function slotParams() {
  const params = new URLSearchParams({
    weekday: String(slot.weekday), section: slot.section,
    page: String(slotPage), page_size: "25", sort: "name",
  });
  const keyword = $("#slotKeyword").value.trim();
  if (keyword) params.set("q", keyword);
  return params;
}

async function searchSlot() {
  if (!slot) return;
  $("#slotStatus").textContent = "搜尋中…";
  $("#slotStatus").classList.remove("hidden");
  try {
    const response = await fetch(`/api/courses?${slotParams()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "搜尋失敗");
    slotCourses = data.items || [];
    slotPage = data.page || 1;
    slotTotalPages = data.total_pages || 1;
    $("#slotStatus").classList.add("hidden");
    renderSlotResults();
  } catch (error) {
    $("#slotStatus").textContent = error.message;
    slotCourses = [];
    slotTotalPages = 1;
    renderSlotResults();
  }
}

function renderSlotResults() {
  const root = $("#slotResults");
  root.replaceChildren();
  if (!slotCourses.length) {
    root.innerHTML = '<div class="empty-result"><strong>這個節次找不到課程</strong><span>可清除關鍵字後再試。</span></div>';
  } else {
    const template = $("#slotCourseTemplate");
    for (const course of slotCourses) {
      const node = template.content.cloneNode(true);
      node.querySelector(".course-name").textContent = course.name;
      node.querySelector(".req-badge").textContent = course.required_elective || "未標示";
      node.querySelector(".course-meta").textContent = [
        course.course_code, course.teacher,
        course.credits !== null && course.credits !== "" ? `${course.credits} 學分` : "",
        course.department, course.class_group,
      ].filter(Boolean).join("｜");
      node.querySelector(".meeting-text").textContent = meetingLabel(course);
      node.querySelector(".outline-link").href = course.outline_url;
      const existing = courses().some((item) => item.id === course.id);
      const conflicts = conflictsFor(course);
      const note = node.querySelector(".conflict-note");
      if (conflicts.length) {
        note.textContent = `會與 ${conflicts.map((item) => item.name).join("、")} 衝堂`;
        note.classList.remove("hidden");
        note.classList.add("danger");
      }
      const add = node.querySelector(".add-btn");
      add.textContent = existing ? "已在課表" : conflicts.length ? "加入（會衝堂）" : "加入課表";
      add.disabled = existing;
      add.addEventListener("click", () => addCourse(course));
      root.append(node);
    }
  }
  $("#slotPageText").textContent = `${slotPage} / ${slotTotalPages}`;
  $("#slotPrevBtn").disabled = slotPage <= 1;
  $("#slotNextBtn").disabled = slotPage >= slotTotalPages;
}

function addCourse(course) {
  if (courses().some((item) => item.id === course.id)) return;
  const conflicts = conflictsFor(course);
  if (conflicts.length && !window.confirm(`「${course.name}」會與 ${conflicts.map((item) => item.name).join("、")} 衝堂，仍要加入嗎？`)) return;
  courses().push(course);
  saveState();
  renderAll();
  renderSlotResults();
}

function removeCourse(courseId) {
  activePlan().courses = courses().filter((course) => course.id !== courseId);
  saveState();
  renderAll();
  renderSlotResults();
}

function openSearchPage() {
  if (!slot) return;
  const url = `/?weekday=${slot.weekday}&section=${encodeURIComponent(slot.section)}`;
  if (window.opener && !window.opener.closed) {
    window.opener.location.href = url;
    window.opener.focus();
  } else {
    window.open(url, "_blank");
  }
}

$("#planSelect").addEventListener("change", (event) => {
  state.activePlanId = event.target.value;
  saveState();
  renderAll();
  if (slot) renderSlotResults();
});
$("#addPlanBtn").addEventListener("click", () => {
  const name = window.prompt("新方案名稱", `方案 ${String.fromCharCode(65 + state.plans.length)}`)?.trim();
  if (!name) return;
  const id = makeId();
  state.plans.push({ id, name, courses: [] });
  state.activePlanId = id;
  saveState();
  renderAll();
});
$("#renamePlanBtn").addEventListener("click", () => {
  const plan = activePlan();
  const name = window.prompt("方案名稱", plan.name)?.trim();
  if (!name) return;
  plan.name = name;
  saveState();
  renderAll();
});
$("#deletePlanBtn").addEventListener("click", () => {
  if (state.plans.length <= 1) return window.alert("至少要保留一個方案。");
  if (!window.confirm(`刪除「${activePlan().name}」？`)) return;
  state.plans = state.plans.filter((plan) => plan.id !== state.activePlanId);
  state.activePlanId = state.plans[0].id;
  saveState();
  renderAll();
});
$("#clearPlanBtn").addEventListener("click", () => {
  if (!courses().length || !window.confirm("清空目前方案的所有課程？")) return;
  activePlan().courses = [];
  saveState();
  renderAll();
  if (slot) renderSlotResults();
});
$("#backToSearchBtn").addEventListener("click", () => {
  if (window.opener && !window.opener.closed) {
    window.opener.focus();
  } else {
    location.href = "/";
  }
});
$("#openInSearchBtn").addEventListener("click", openSearchPage);
$("#closeSlotBtn").addEventListener("click", () => $("#slotSearchPanel").classList.add("hidden"));
$("#slotSearchBtn").addEventListener("click", () => { slotPage = 1; searchSlot(); });
$("#slotKeyword").addEventListener("keydown", (event) => {
  if (event.key === "Enter") { slotPage = 1; searchSlot(); }
});
$("#slotPrevBtn").addEventListener("click", () => { if (slotPage > 1) { slotPage -= 1; searchSlot(); } });
$("#slotNextBtn").addEventListener("click", () => { if (slotPage < slotTotalPages) { slotPage += 1; searchSlot(); } });

window.addEventListener("storage", (event) => {
  if (event.key !== stateKey) return;
  state = loadState();
  renderAll();
  if (slot) renderSlotResults();
});

document.addEventListener("dblclick", (event) => {
  const courseButton = event.target.closest(".timetable-course");
  if (!courseButton) return;
  const name = courseButton.textContent;
  const course = courses().find((item) => item.name === name);
  if (course && window.confirm(`從課表移除「${course.name}」？`)) removeCourse(course.id);
});

try {
  const response = await fetch("/api/meta");
  meta = await response.json();
  if (response.ok) $("#termText").textContent = `${meta.academic_year} 學年度第 ${meta.semester} 學期`;
} catch {}
renderAll();
