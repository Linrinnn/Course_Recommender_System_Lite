import {
  SECTION_TIMES, SECTION_ORDER, WEEKDAYS, SCHEMA_VERSION, termKey, meetingSlots, busySlots,
  conflictsWith, scheduleStats, timetableMatrix, comparePlans, validateBackup, createICS, safeCourse
} from "./schedule-core.mjs";

const $ = (selector) => document.querySelector(selector);
const stateKey = "fju-course-liteplus:state";
const weekdays = WEEKDAYS;
const sectionTimes = SECTION_TIMES;
const sectionOrder = SECTION_ORDER;
const preferenceKey = "fju-course-liteplus:schedule-preferences-v2";
let state = loadState(), meta = null, slot = null, slotPage = 1, slotTotalPages = 1;
let slotCourses = [], detailCourse = null, replaceId = null, undoAction = null, activeTerm = null;
let ui = {mode: window.matchMedia("(max-width: 680px)").matches ? "day" : "week", day: 1, weekend: true};
let preferences = loadPreferences();
let slotRequest = 0;

function makeId() { return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,8); }
function loadPreferences() {
  try { return {...{noEarly:false,noLate:false,compact:false}, ...JSON.parse(localStorage.getItem(preferenceKey) || "{}")}; }
  catch { return {noEarly:false,noLate:false,compact:false}; }
}
function loadState() {
  try {
    const parsed=JSON.parse(localStorage.getItem(stateKey)||"null");
    if(parsed && Array.isArray(parsed.plans) && parsed.plans.length) {
      parsed.schemaVersion=SCHEMA_VERSION;
      parsed.plans=parsed.plans.map(p=>({...p, busyBlocks:Array.isArray(p.busyBlocks)?p.busyBlocks:[]}));
      return parsed;
    }
  } catch {}
  const id=makeId();
  return {schemaVersion:SCHEMA_VERSION,activePlanId:id,plans:[{id,name:"方案 A",courses:[],busyBlocks:[],termKey:null}]};
}
function saveState() {
  state.schemaVersion=SCHEMA_VERSION;
  state.lastUpdated=new Date().toISOString();
  try { localStorage.setItem(stateKey,JSON.stringify(state)); }
  catch { notify("儲存失敗：瀏覽器空間不足。請先匯出 JSON 備份。"); }
}
function activateTerm(metaData) {
  activeTerm=termKey(metaData.academic_year,metaData.semester);
  state.academicYear=metaData.academic_year;
  state.semester=metaData.semester;
  for(const plan of state.plans) if(!plan.termKey) plan.termKey=activeTerm; // Preserve pre-versioned legacy plans.
  const inTerm=state.plans.filter(p=>p.termKey===activeTerm);
  if(!inTerm.length) {
    const id=makeId();
    state.plans.push({id,name:"新學期方案",termKey:activeTerm,courses:[],busyBlocks:[]});
    state.activePlanId=id;
    notify("已建立此學期的新課表。之前學期的課表仍保存在瀏覽器及 JSON 備份中。");
  } else if (!inTerm.some(p=>p.id===state.activePlanId)) state.activePlanId=inTerm[0].id;
  saveState();
}
function termPlans() { return state.plans.filter(p=>!activeTerm || !p.termKey || p.termKey===activeTerm); }
function activePlan() {
  let plan=state.plans.find(p=>p.id===state.activePlanId && (!activeTerm||p.termKey===activeTerm));
  if(!plan) {
    plan=termPlans()[0];
    if(plan) state.activePlanId=plan.id;
  }
  return plan;
}
function courses() { return activePlan()?.courses || []; }
function busyBlocks() { return activePlan()?.busyBlocks || []; }
function notify(message,{undo=false}={}) {
  $("#scheduleNotice").classList.remove("hidden");
  $("#scheduleNoticeText").textContent=message;
  $("#undoBtn").classList.toggle("hidden",!undo);
}
function clearNotice() { $("#scheduleNotice").classList.add("hidden"); $("#undoBtn").classList.add("hidden"); undoAction=null; }
function timeLabel(day) { return "星期"+weekdays[day]; }
function meetingLabel(course) {
  if(!course.meetings?.length) return "上課時間未提供";
  return course.meetings.map(m=>{
    const sections=m.sections?.join("、")||m.section_raw||"時間未定";
    return timeLabel(m.weekday||0)+" "+sections+(m.room?" · "+m.room:"");
  }).join("；");
}
function getFirstSlot(course) {
  for(const meeting of course.meetings||[]){
    const first=(meeting.sections||[]).find(x=>SECTION_TIMES[x]);
    if(meeting.weekday && first) return {weekday:Number(meeting.weekday),section:first};
  }
  return null;
}
function escapeHtml(value) {
  return String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
}
function renderPlanControls(){
  const plan=activePlan(),select=$("#planSelect"),compare=$("#comparePlanSelect");
  select.replaceChildren();
  compare.replaceChildren(new Option("選擇另一方案",""));
  for(const p of termPlans()) {
    select.append(new Option(p.name,p.id,false,p.id===state.activePlanId));
    if(p.id!==state.activePlanId)compare.append(new Option(p.name,p.id));
  }
  $("#deletePlanBtn").disabled=termPlans().length<=1;
  $("#comparePlanBtn").disabled=termPlans().length<=1;
  const stats=scheduleStats(courses(),busyBlocks());
  for(const [id,value] of Object.entries({
    statCourses:stats.courseCount,statCredits:stats.credits,statWeekly:stats.weeklySections,
    statGaps:stats.gapSections,statConflicts:stats.conflictSlots,statUnknown:stats.unknownCount
  })) $( "#"+id).textContent=String(value);
  $("#planSummary").textContent=plan.name+" · "+stats.courseCount+" 門 · "+stats.credits+" 學分";
  $("#statConflicts").closest(".stat").classList.toggle("stat-alert",stats.conflictSlots>0);
  $("#statUnknown").closest(".stat").classList.toggle("stat-alert",stats.unknownCount>0);
  if(meta) $("#termText").textContent=meta.academic_year+" 學年度第 "+meta.semester+" 學期";
}
function renderTimetable(){
  const days = ui.mode==="day"?[ui.day]:(ui.weekend?[1,2,3,4,5,6,7]:[1,2,3,4,5]);
  const table=document.createElement("table");
  table.className="timetable timetable-combined";
  const thead=document.createElement("thead"),head=document.createElement("tr");
  head.append(cell("th","節次"));
  for(const day of days)head.append(cell("th",timeLabel(day)));
  thead.append(head);table.append(thead);
  const body=document.createElement("tbody"),matrix=timetableMatrix(courses(),busyBlocks(),days);
  for(const section of sectionOrder){
    const row=document.createElement("tr");
    const label=cell("th","");
    const line=document.createElement("strong");line.textContent=section;
    const hour=document.createElement("span");hour.textContent=sectionTimes[section].join("–");
    label.append(line,hour);row.append(label);
    for(const day of days) {
      const entry=matrix.get(day+":"+section);
      if(!entry?.start) continue;
      const td=document.createElement("td");
      td.className="schedule-slot-cell";
      if(entry.span>1)td.rowSpan=entry.span;
      const overlaps=entry.items.filter(x=>x.type==="course").length>1 ||
        (entry.items.some(x=>x.type==="course") && entry.items.some(x=>x.type==="busy"));
      if(overlaps)td.classList.add("conflict-cell");
      for(const item of entry.items) {
        const chip=document.createElement("button");
        chip.type="button";
        if(item.type==="course"){
          const course=item.data;
          chip.className="timetable-course color-"+(hashColor(item.id)%7);
          const title=document.createElement("strong");title.textContent=course.name;
          const sub=document.createElement("span");
          sub.textContent=[course.teacher,findRoom(course,day,section)].filter(Boolean).join(" · ");
          chip.append(title,sub);
          chip.title=meetingLabel(course);
          chip.setAttribute("aria-label","查看課程："+course.name);
          chip.addEventListener("click",ev=>{ev.stopPropagation();openCourse(course);});
        }else {
          chip.className="timetable-busy";
          chip.textContent=item.data.label||"忙碌時段";
          chip.title="自訂忙碌時段 · 可在下方清單移除";
          chip.addEventListener("click",ev=>{ev.stopPropagation();$("#busyList").scrollIntoView({behavior:"smooth"});});
        }
        td.append(chip);
      }
      const open=document.createElement("button");
      open.type="button";
      open.className=entry.items.length?"slot-search-mini":"slot-search-button";
      open.textContent=entry.items.length?"＋":"＋ 找課";
      open.setAttribute("aria-label",timeLabel(day)+" "+section+" 搜尋其他課程");
      open.addEventListener("click",ev=>{ev.stopPropagation();openSlot(day,section);});
      td.append(open);
      td.addEventListener("click",()=>openSlot(day,section));
      row.append(td);
    }
    body.append(row);
  }
  table.append(body);
  $("#timetableWrap").replaceChildren(table);
  $("#dayNavigation").classList.toggle("hidden",ui.mode!=="day");
  $("#daySelect").parentElement.classList.toggle("hidden",ui.mode!=="day");
  $("#currentDayLabel").textContent=timeLabel(ui.day);
  $("#daySelect").value=String(ui.day);
  $("#viewMode").value=ui.mode;
  $("#showWeekend").checked=ui.weekend;
  $("#showWeekend").parentElement.classList.toggle("hidden",ui.mode==="day");
}
function cell(tag,text){const c=document.createElement(tag);c.textContent=text;return c;}
function hashColor(str){return String(str).split("").reduce((a,ch)=>a*31+ch.charCodeAt(0),0)>>>0;}
function findRoom(course,day,section){
  const m=(course.meetings||[]).find(m=>Number(m.weekday)===day&&(m.sections||[]).includes(section));
  return m?.room||"";
}
function renderBusyList() {
  const root=$("#busyList");root.replaceChildren();
  if(!busyBlocks().length){root.textContent="目前沒有自訂忙碌時段。";return;}
  for(const b of busyBlocks()){
    const row=document.createElement("div");row.className="busy-list-row";
    const label=cell("span",b.label+" · "+timeLabel(b.weekday)+" "+b.start+"–"+b.end);
    const remove=cell("button","移除");remove.type="button";remove.className="secondary";
    remove.addEventListener("click",()=>{activePlan().busyBlocks=busyBlocks().filter(x=>x.id!==b.id);saveState();renderAll();});
    row.append(label,remove);root.append(row);
  }
}
function renderInsights(){
  const stats=scheduleStats(courses(),busyBlocks());
  const messages=[];
  if(stats.gapSections>0)messages.push("本週有 "+stats.gapSections+" 節空堂，集中同一天的課可能減少等待。");
  else messages.push("目前沒有課與課之間的空堂。");
  if(stats.conflictSlots)messages.push("有 "+stats.conflictSlots+" 個衝堂／忙碌時段重疊，請查看紅色區塊。");
  if(stats.unknownCount)messages.push(stats.unknownCount+" 門課時間未完整標示，請查閱官方課綱。");
  const sections=courses().flatMap(c=>[...meetingSlots(c)].map(s=>s.split(":")[1]));
  if(preferences.noEarly && sections.some(s=>["D0","D1","D2"].includes(s)))messages.push("注意：目前有早課，與「避免早八」偏好不符。");
  if(preferences.noLate && sections.some(s=>s.startsWith("E")))messages.push("注意：目前有晚課，與偏好不符。");
  if(preferences.compact && stats.gapSections)messages.push("可複製目前方案，試著替換課程比較空堂數。");
  $("#insightText").replaceChildren(...messages.map(text=>{const p=document.createElement("p");p.textContent=text;return p;}));
}
function renderAll() {renderPlanControls();renderTimetable();renderBusyList();renderInsights();}
function addTermGuard(){
  if(!meta)return;
  const message=activePlan()?.termKey!==activeTerm ? "這個方案屬於其他學期，已禁止編輯。" : "";
  $("#semesterWarning").textContent=message;
  $("#semesterWarning").classList.toggle("hidden",!message);
}
function openCourse(course){
  detailCourse=course;
  const dlg=$("#scheduleCourseDialog");
  $("#drawerCourseName").textContent=course.name;
  const conflicts=conflictsWith(course,courses(),busyBlocks());
  const rows=[
    ["課號",course.course_code||"—"],["教師",course.teacher||"—"],
    ["系所",course.department||"—"],["年級／班別",[course.grade?course.grade+" 年級":"",course.class_group].filter(Boolean).join(" · ")||"—"],
    ["學分",String(course.credits_number??course.credits??"—")],
    ["必／選修",course.required_elective||"—"],["上課時間／教室",meetingLabel(course)],
    ["衝堂",conflicts.courses.length||conflicts.busy.length?
      [...conflicts.courses.map(c=>c.name),...conflicts.busy.map(b=>b.label)].join("、"):"沒有發現固定節次衝堂"],
    ["資料狀態",meetingSlots(course).size?"有固定節次":"時間未定，請自行確認"]
  ];
  const content=$("#drawerCourseDetails");
  content.replaceChildren();
  const dl=document.createElement("dl");dl.className="course-drawer-grid";
  for(const [name,value] of rows){dl.append(cell("dt",name),cell("dd",value));}
  content.append(dl);
  const link=$("#drawerOutlineLink");
  if(course.outline_url){link.href=course.outline_url;link.classList.remove("hidden");}
  else {link.removeAttribute("href");link.classList.add("hidden");}
  if(!dlg.open)dlg.showModal();
}
function removeCourse(id){
  const plan=activePlan(),index=plan.courses.findIndex(c=>String(c.id)===String(id));
  if(index<0)return;
  const [course]=plan.courses.splice(index,1);
  undoAction={planId:plan.id,index,course};
  saveState();renderAll();
  if(slot)renderSlotResults();
  notify("已從課表移除「"+course.name+"」。",{undo:true});
}
function undoRemove(){
  if(!undoAction)return;
  const action=undoAction,plan=state.plans.find(p=>p.id===action.planId);
  if(plan && !plan.courses.some(c=>String(c.id)===String(action.course.id))){
    plan.courses.splice(Math.min(action.index,plan.courses.length),0,action.course);
    saveState();renderAll();if(slot)renderSlotResults();
    notify("已復原「"+action.course.name+"」。");
  }
  undoAction=null;$("#undoBtn").classList.add("hidden");
}
function addCourse(course){
  if(courses().some(x=>String(x.id)===String(course.id)))return;
  const target=courses().find(x=>String(x.id)===String(replaceId));
  const remaining=courses().filter(x=>x!==target);
  const clash=conflictsWith(course,remaining,busyBlocks());
  const label=[...clash.courses.map(c=>c.name),...clash.busy.map(b=>b.label)].join("、");
  if(label && !window.confirm("這門課與「"+label+"」重疊。仍要加入嗎？"))return;
  if(!meetingSlots(course).size && !window.confirm("這門課尚無固定上課時間，無法完整檢查衝堂。仍要加入嗎？"))return;
  if(target)activePlan().courses=remaining;
  activePlan().courses.push(course);
  const replacing=Boolean(target);
  replaceId=null;
  saveState();renderAll();renderSlotResults();
  notify(replacing?"已替換課程。":"已加入「"+course.name+"」。");
}
async function openSlot(weekday,section){
  slot={weekday,section};
  slotPage=1;
  $("#slotSearchPanel").classList.remove("hidden");
  $("#slotTitle").textContent=timeLabel(weekday)+" "+section+" 的課程";
  $("#slotSubtitle").textContent=replaceId?"選擇替代課程；會檢查新課程的所有時段。":"依指定星期及節次搜尋；加入時檢查所有時段是否衝堂。";
  $("#slotKeyword").value="";
  await searchSlot();
  $("#slotSearchPanel").scrollIntoView({behavior:"smooth",block:"start"});
}
function slotParams(){
  const p=new URLSearchParams({weekday:String(slot.weekday),section:slot.section,page:String(slotPage),page_size:"25",sort:"name"});
  if($("#slotKeyword").value.trim())p.set("q",$("#slotKeyword").value.trim());
  return p;
}
async function searchSlot(){
  if(!slot)return;
  const req=++slotRequest;
  $("#slotStatus").textContent="搜尋中…";
  $("#slotStatus").classList.remove("hidden");
  try {
    const response=await fetch("/api/courses?"+slotParams());
    const data=await response.json();
    if(req!==slotRequest)return;
    if(!response.ok)throw Error(data.detail||"搜尋失敗");
    slotCourses=data.items||[];
    slotPage=data.page||1;slotTotalPages=data.total_pages||1;
    $("#slotStatus").classList.add("hidden");renderSlotResults();
  }catch(e) {
    if(req!==slotRequest)return;
    $("#slotStatus").textContent=e.message;slotCourses=[];slotTotalPages=1;renderSlotResults();
  }
}
function renderSlotResults(){
  const root=$("#slotResults");root.replaceChildren();
  if(!slotCourses.length) {
    root.innerHTML='<div class="empty-result"><strong>沒有符合的課程</strong><span>可以清除關鍵字再試。</span></div>';
  } else {
    for(const course of slotCourses){
      const node=$("#slotCourseTemplate").content.cloneNode(true);
      node.querySelector(".course-name").textContent=course.name;
      node.querySelector(".req-badge").textContent=course.required_elective||"未標示";
      node.querySelector(".course-meta").textContent=[course.course_code,course.teacher,course.department,
        course.credits_number!=null?course.credits_number+" 學分":""].filter(Boolean).join(" · ");
      node.querySelector(".meeting-text").textContent=meetingLabel(course);
      const link=node.querySelector(".outline-link");
      if(course.outline_url)link.href=course.outline_url;else link.classList.add("hidden");
      const existing=courses().some(x=>String(x.id)===String(course.id));
      const target=courses().find(x=>String(x.id)===String(replaceId));
      const clash=conflictsWith(course,courses().filter(x=>x!==target),busyBlocks());
      const label=[...clash.courses.map(c=>c.name),...clash.busy.map(b=>b.label)].join("、");
      const note=node.querySelector(".conflict-note");
      if(label) {note.textContent="衝堂："+label;note.classList.remove("hidden");note.classList.add("danger");}
      else if(!meetingSlots(course).size){note.textContent="時間未定，無法判斷衝堂";note.classList.remove("hidden");}
      const add=node.querySelector(".add-btn");
      add.textContent=existing?"已加入":replaceId?"替換成這門":"加入課表";
      add.disabled=existing;
      add.addEventListener("click",()=>addCourse(course));
      root.append(node);
    }
  }
  $("#slotPageText").textContent=slotPage+" / "+slotTotalPages;
  $("#slotPrevBtn").disabled=slotPage<=1;
  $("#slotNextBtn").disabled=slotPage>=slotTotalPages;
}
function openSearchPage(){
  if(!slot)return;
  const url="./?weekday="+slot.weekday+"&section="+encodeURIComponent(slot.section);
  if(window.opener && !window.opener.closed) {
    window.opener.location.href=url;window.opener.focus();
  }else window.open(url,"_blank","noopener");
}
function downloadFile(content,type,name){
  const blob=content instanceof Blob?content:new Blob([content],{type});
  const url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=name;document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}
function filename(ext){
  return "輔大課表-"+(activeTerm||"學期未定")+"-"+activePlan().name.replace(/[\\/:*?"<>|]/g,"-")+"."+ext;
}
function exportBackup(){
  const data={schemaVersion:SCHEMA_VERSION,academicYear:meta?.academic_year??state.academicYear,
    semester:meta?.semester??state.semester,activePlanId:state.activePlanId,plans:state.plans,
    exportedAt:new Date().toISOString()};
  downloadFile(JSON.stringify(data,null,2),"application/json;charset=utf-8",filename("json"));
}
async function importBackup(file){
  if(!file)return;
  if(file.size>5_000_000){notify("備份檔過大（限 5 MB）。");return;}
  try {
    const raw=JSON.parse(await file.text()),backup=validateBackup(raw);
    const names=backup.plans.map(p=>p.name).slice(0,6).join("、");
    if(!window.confirm("備份包含 "+backup.plans.length+" 個方案（"+names+"）。匯入後將取代此瀏覽器目前全部方案，建議先匯出備份。繼續嗎？"))return;
    const key=backup.academicYear!=null&&backup.semester!=null?termKey(backup.academicYear,backup.semester):activeTerm;
    for(const plan of backup.plans)if(!plan.termKey)plan.termKey=key;
    state=backup;
    if(meta)activateTerm(meta);
    else saveState();
    renderAll();notify("備份已匯入成功。");
  }catch(error){notify("無法匯入："+error.message);}
  finally {$("#backupFile").value="";}
}
function exportICS(){
  if(!meta){notify("學期資料尚未載入，無法正確設定行事曆週數。");return;}
  try{
    const result=createICS(courses(),{semesterStart:meta.semester_start,semesterWeeks:meta.semester_weeks,
      stamp:new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d{3}/,"")});
    if(!result.exported){notify("課表沒有可匯出的固定時間課程。");return;}
    if(!window.confirm("將匯出 "+result.exported+" 個固定時間行事曆事件。"+
      (result.skipped?"另有 "+result.skipped+" 門時間未定的課程未包含。":"")+
      "\n不會自動排除國定假日、停補課或特殊授課週次，請以學校公告為準。繼續？"))return;
    downloadFile(result.content,"text/calendar;charset=utf-8",filename("ics"));
  }catch(error){notify(error.message);}
}
function drawPng(){
  const dayCount=ui.weekend?7:5,days=Array.from({length:dayCount},(_,i)=>i+1);
  const w=1360,head=135,rowHeight=82,left=90,col=(w-left)/dayCount,h=head+rowHeight*sectionOrder.length+32;
  const canvas=document.createElement("canvas");canvas.width=w*2;canvas.height=h*2;
  const ctx=canvas.getContext("2d");ctx.scale(2,2);
  ctx.fillStyle="#fff";ctx.fillRect(0,0,w,h);
  ctx.fillStyle="#243d30";ctx.font="bold 29px sans-serif";ctx.fillText(activePlan().name,25,47);
  const stats=scheduleStats(courses(),busyBlocks());
  ctx.fillStyle="#74867a";ctx.font="18px sans-serif";
  ctx.fillText((activeTerm||"")+" | "+stats.courseCount+" 門 · "+stats.credits+" 學分 · "+stats.gapSections+" 節空堂",25,85);
  ctx.fillStyle="#f2f5f2";ctx.fillRect(0,head-35,w,40);
  ctx.fillStyle="#506558";ctx.font="bold 17px sans-serif";
  days.forEach((day,i)=>ctx.fillText(timeLabel(day),left+i*col+10,head-10));
  ctx.fillStyle="#849488";ctx.fillText("節次",15,head-10);
  const m=timetableMatrix(courses(),busyBlocks(),days);
  for(let idx=0;idx<sectionOrder.length;idx++){
    const section=sectionOrder[idx],y=head+idx*rowHeight;
    ctx.strokeStyle="#e7ede7";ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();
    ctx.fillStyle="#64766b";ctx.font="bold 16px sans-serif";ctx.fillText(section,17,y+27);
    ctx.font="12px sans-serif";ctx.fillText(SECTION_TIMES[section][0],12,y+49);
    for(let i=0;i<days.length;i++){
      const x=left+i*col,entry=m.get(days[i]+":"+section);
      if(!entry?.start||!entry.items.length)continue;
      const height=entry.span*rowHeight-6;
      const conflicts=entry.items.filter(item=>item.type==="course").length>1;
      ctx.fillStyle=conflicts?"#ffe4dc":entry.items[0].type==="busy"?"#edf0f2":"#e7f2eb";
      ctx.fillRect(x+3,y+3,col-6,height);
      ctx.fillStyle=conflicts?"#a74235":"#2d5a41";ctx.font="bold 15px sans-serif";
      let lineY=y+25;
      for(const item of entry.items.slice(0,Math.max(1,Math.floor(height/45)))){
        const title=item.type==="course"?item.data.name:item.data.label;
        ctx.fillText(title.slice(0,Math.floor(col/13)),x+9,lineY,col-18);lineY+=22;
        if(item.type==="course") {ctx.font="12px sans-serif";ctx.fillText(findRoom(item.data,days[i],section).slice(0,17),x+9,lineY,col-18);lineY+=25;}
        ctx.font="bold 15px sans-serif";
      }
    }
  }
  canvas.toBlob(blob=>{if(blob)downloadFile(blob,"image/png",filename("png"));else notify("圖片輸出失敗。");},"image/png");
}
function updateComparison(){
  const target=state.plans.find(p=>p.id===$("#comparePlanSelect").value);
  const root=$("#planCompareResults");
  if(!target){root.classList.add("hidden");return;}
  const info=comparePlans(activePlan(),target);
  root.replaceChildren();
  const table=document.createElement("table");table.className="comparison-table";
  for(const [label,a,b] of [["統計",activePlan().name,target.name],
    ["課程數",info.a.courseCount,info.b.courseCount],["學分",info.a.credits,info.b.credits],
    ["每週節數",info.a.weeklySections,info.b.weeklySections],["空堂",info.a.gapSections,info.b.gapSections],
    ["衝堂",info.a.conflictSlots,info.b.conflictSlots],["時間未定",info.a.unknownCount,info.b.unknownCount]]){
    const tr=document.createElement("tr");
    for(const value of [label,a,b])tr.append(cell("td",String(value)));
    table.append(tr);
  }
  root.append(table,cell("p","僅在目前方案："+(info.onlyA.join("、")||"無")),
    cell("p","僅在比較方案："+(info.onlyB.join("、")||"無")));
  root.classList.remove("hidden");
}

// Page events.
$("#planSelect").addEventListener("change",ev=>{state.activePlanId=ev.target.value;saveState();renderAll();if(slot)renderSlotResults();});
$("#addPlanBtn").addEventListener("click",()=>{
  const name=window.prompt("新方案名稱","方案 "+String.fromCharCode(65+termPlans().length))?.trim();
  if(!name)return;
  const id=makeId();state.plans.push({id,name:name.slice(0,70),termKey:activeTerm,courses:[],busyBlocks:[]});
  state.activePlanId=id;saveState();renderAll();
});
$("#clonePlanBtn").addEventListener("click",()=>{
  const current=activePlan(),name=window.prompt("複製方案名稱",current.name+"（副本）")?.trim();
  if(!name)return;
  const id=makeId();state.plans.push({id,name:name.slice(0,70),termKey:activeTerm,
    courses:current.courses.map(c=>structuredClone(c)),busyBlocks:current.busyBlocks.map(b=>structuredClone(b))});
  state.activePlanId=id;saveState();renderAll();notify("已複製方案，修改副本不會影響原本方案。");
});
$("#renamePlanBtn").addEventListener("click",()=>{
  const plan=activePlan(),name=window.prompt("方案名稱",plan.name)?.trim();
  if(!name)return;
  plan.name=name.slice(0,70);saveState();renderAll();
});
$("#deletePlanBtn").addEventListener("click",()=>{
  if(termPlans().length<=1){notify("同一學期至少要有一個方案。");return;}
  if(!window.confirm("確定刪除「"+activePlan().name+"」？此操作不可復原。"))return;
  state.plans=state.plans.filter(p=>p.id!==state.activePlanId);
  state.activePlanId=termPlans()[0].id;saveState();renderAll();
});
$("#clearPlanBtn").addEventListener("click",()=>{
  if(!courses().length||!window.confirm("清空本方案的所有課程？忙碌時段將保留。"))return;
  activePlan().courses=[];saveState();renderAll();if(slot)renderSlotResults();
});
$("#backToSearchBtn").addEventListener("click",()=>{
  if(window.opener && !window.opener.closed)window.opener.focus();
  else location.href="./";
});
$("#viewMode").addEventListener("change",ev=>{ui.mode=ev.target.value;renderTimetable();});
$("#daySelect").addEventListener("change",ev=>{ui.day=Number(ev.target.value);renderTimetable();});
$("#showWeekend").addEventListener("change",ev=>{ui.weekend=ev.target.checked;renderTimetable();});
$("#prevDayBtn").addEventListener("click",()=>{ui.day=ui.day===1?7:ui.day-1;renderTimetable();});
$("#nextDayBtn").addEventListener("click",()=>{ui.day=ui.day===7?1:ui.day+1;renderTimetable();});
$("#closeCourseDrawerBtn").addEventListener("click",()=>$("#scheduleCourseDialog").close());
$("#scheduleCourseDialog").addEventListener("click",ev=>{if(ev.target===$("#scheduleCourseDialog"))$("#scheduleCourseDialog").close();});
$("#removeCourseBtn").addEventListener("click",()=>{
  if(!detailCourse)return;
  const id=detailCourse.id;
  $("#scheduleCourseDialog").close();removeCourse(id);detailCourse=null;
});
$("#replaceCourseBtn").addEventListener("click",()=>{
  if(!detailCourse)return;
  const first=getFirstSlot(detailCourse);
  if(!first){notify("原課時間未定，請返回搜尋頁選擇替代課程。");return;}
  replaceId=detailCourse.id;
  $("#scheduleCourseDialog").close();
  openSlot(first.weekday,first.section);
});
$("#undoBtn").addEventListener("click",undoRemove);
$("#dismissNoticeBtn").addEventListener("click",clearNotice);
$("#busyForm").addEventListener("submit",ev=>{
  ev.preventDefault();
  const block={id:makeId(),label:$("#busyLabel").value.trim(),weekday:Number($("#busyDay").value),
    start:$("#busyStart").value,end:$("#busyEnd").value};
  if(!block.label||!busySlots(block).size){notify("請確認用途與節次範圍。");return;}
  activePlan().busyBlocks.push(block);saveState();renderAll();
  $("#busyLabel").value="";notify("已新增忙碌時段。");
});
$("#comparePlanBtn").addEventListener("click",updateComparison);
$("#exportBackupBtn").addEventListener("click",exportBackup);
$("#importBackupBtn").addEventListener("click",()=>$("#backupFile").click());
$("#backupFile").addEventListener("change",ev=>importBackup(ev.target.files?.[0]));
$("#exportIcsBtn").addEventListener("click",exportICS);
$("#exportPngBtn").addEventListener("click",drawPng);
$("#printPdfBtn").addEventListener("click",()=>window.print());
for(const [selector,key] of [["#prefNoEarly","noEarly"],["#prefNoLate","noLate"],["#prefCompact","compact"]]){
  $(selector).checked=preferences[key];
  $(selector).addEventListener("change",ev=>{
    preferences[key]=ev.target.checked;localStorage.setItem(preferenceKey,JSON.stringify(preferences));renderInsights();
  });
}
$("#openInSearchBtn").addEventListener("click",openSearchPage);
$("#closeSlotBtn").addEventListener("click",()=>{replaceId=null;$("#slotSearchPanel").classList.add("hidden");});
$("#slotSearchBtn").addEventListener("click",()=>{slotPage=1;searchSlot();});
$("#slotKeyword").addEventListener("keydown",ev=>{if(ev.key==="Enter"){slotPage=1;searchSlot();}});
$("#slotPrevBtn").addEventListener("click",()=>{if(slotPage>1){slotPage--;searchSlot();}});
$("#slotNextBtn").addEventListener("click",()=>{if(slotPage<slotTotalPages){slotPage++;searchSlot();}});
window.addEventListener("storage",ev=>{
  if(ev.key!==stateKey)return;
  state=loadState();if(meta)activateTerm(meta);renderAll();if(slot)renderSlotResults();
});
for(let day=1;day<=7;day++)$("#busyDay").append(new Option(timeLabel(day),String(day)));
for(const section of sectionOrder)for(const id of ["#busyStart","#busyEnd"]){
  $(id).append(new Option(section+" "+sectionTimes[section].join("–"),section));
}
$("#busyStart").value="D5";$("#busyEnd").value="D6";

try {
  const response=await fetch("/api/meta");
  if(response.ok){
    meta=await response.json();activateTerm(meta);
  }else notify("未能讀取學期資訊。請先確認資料來源。");
} catch {notify("目前離線，已儲存的課表仍可編輯。");}
renderAll();
addTermGuard();
