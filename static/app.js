const $ = (selector) => document.querySelector(selector);
const weekdays = ["", "一", "二", "三", "四", "五", "六", "日"];
const storageKey = "fju-course-lite:selected";

let currentCourses = [];
let selected = loadSelected();

function loadSelected() {
  try { return JSON.parse(localStorage.getItem(storageKey) || "[]"); }
  catch { return []; }
}

function saveSelected() {
  localStorage.setItem(storageKey, JSON.stringify(selected));
}

function meetingLabel(course) {
  if (!course.meetings?.length) return "時間未提供";
  return course.meetings.map((m) => {
    const sections = m.sections?.join(", ") || m.section_raw || "?";
    const room = m.room ? `｜${m.room}` : "";
    return `週${weekdays[m.weekday] || "?"} ${sections}${room}`;
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
  return selected.filter((item) => item.id !== course.id && conflict(item, course));
}

function addCourse(course) {
  if (selected.some((item) => item.id === course.id)) return;
  const conflicts = findConflicts(course);
  if (conflicts.length) {
    $("#conflictBox").classList.remove("hidden");
    $("#conflictBox").textContent = `衝堂：${course.name} 與 ${conflicts.map((x) => x.name).join("、")}`;
    return;
  }
  $("#conflictBox").classList.add("hidden");
  selected.push(course);
  saveSelected();
  renderSelected();
  renderCourses();
}

function removeCourse(id) {
  selected = selected.filter((item) => item.id !== id);
  saveSelected();
  renderSelected();
  renderCourses();
}

function renderSelected() {
  const root = $("#selectedList");
  root.replaceChildren();
  if (!selected.length) {
    root.innerHTML = '<p class="empty">尚未加入課程。</p>';
    return;
  }
  for (const course of selected) {
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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  }[char]));
}

function renderCourses() {
  const root = $("#courseList");
  root.replaceChildren();
  const template = $("#courseTemplate");
  for (const course of currentCourses) {
    const node = template.content.cloneNode(true);
    node.querySelector(".course-name").textContent = course.name;
    node.querySelector(".req-badge").textContent = course.required_elective || "未標示";
    node.querySelector(".course-meta").textContent = [
      course.course_code,
      course.teacher,
      course.credits ? `${course.credits} 學分` : "",
      course.department,
    ].filter(Boolean).join("｜");
    node.querySelector(".meeting-text").textContent = meetingLabel(course);
    const link = node.querySelector(".outline-link");
    link.href = course.outline_url;
    const button = node.querySelector(".add-btn");
    const exists = selected.some((item) => item.id === course.id);
    button.textContent = exists ? "已加入" : "加入課表";
    button.disabled = exists;
    button.addEventListener("click", () => addCourse(course));
    root.append(node);
  }
}

async function loadMeta() {
  const meta = await fetch("/api/meta").then((r) => r.json());
  $("#termText").textContent = `資料來源：輔仁大學公開課程大綱 API｜${meta.academic_year} 學年度第 ${meta.semester} 學期`;
}

async function search() {
  $("#status").textContent = "載入中…";
  $("#status").classList.remove("hidden");
  const params = new URLSearchParams({ page_size: "100" });
  const q = $("#searchInput").value.trim();
  const weekday = $("#weekdaySelect").value;
  const req = $("#reqSelect").value;
  if (q) params.set("q", q);
  if (weekday) params.set("weekday", weekday);
  if (req) params.set("required_elective", req);

  try {
    const response = await fetch(`/api/courses?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "讀取失敗");
    currentCourses = data.items;
    $("#resultCount").textContent = `共 ${data.total} 門，顯示前 ${data.items.length} 門`;
    $("#status").classList.add("hidden");
    renderCourses();
  } catch (error) {
    $("#status").textContent = error.message;
    currentCourses = [];
    renderCourses();
  }
}

$("#searchBtn").addEventListener("click", search);
$("#searchInput").addEventListener("keydown", (event) => { if (event.key === "Enter") search(); });
$("#clearBtn").addEventListener("click", () => {
  selected = [];
  saveSelected();
  $("#conflictBox").classList.add("hidden");
  renderSelected();
  renderCourses();
});
$("#refreshBtn").addEventListener("click", async () => {
  const button = $("#refreshBtn");
  button.disabled = true;
  button.textContent = "更新中…";
  try {
    const response = await fetch("/api/refresh", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "更新失敗");
    await search();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "重新抓取課程";
  }
});

renderSelected();
await loadMeta();
await search();
