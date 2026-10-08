// Shared, side-effect free timetable calculations. All weekdays: 1 (Mon) ... 7 (Sun).
export const SECTION_TIMES = Object.freeze({
  D0: ["07:10","08:00"], D1: ["08:10","09:00"], D2: ["09:10","10:00"],
  D3: ["10:10","11:00"], D4: ["11:10","12:00"], DN: ["12:40","13:30"],
  D5: ["13:40","14:30"], D6: ["14:40","15:30"], D7: ["15:40","16:30"],
  D8: ["16:40","17:30"], E0: ["17:40","18:30"], E1: ["18:40","19:30"],
  E2: ["19:35","20:20"], E3: ["20:30","21:20"], E4: ["21:25","22:10"]
});
export const SECTION_ORDER = Object.keys(SECTION_TIMES);
export const WEEKDAYS = ["","一","二","三","四","五","六","日"];
export const SCHEMA_VERSION = 2;
const validDay = (n) => Number.isInteger(Number(n)) && Number(n) >= 1 && Number(n) <= 7;
export const termKey = (year, semester) => String(year) + "-" + String(semester);

export function meetingSlots(course) {
  const slots = new Set();
  for (const meeting of course?.meetings || []) {
    const day = Number(meeting.weekday);
    if (!validDay(day)) continue;
    for (const section of meeting.sections || []) {
      if (SECTION_TIMES[section]) slots.add(day + ":" + section);
    }
  }
  return slots;
}
export function busySlots(block) {
  const day = Number(block.weekday);
  if (!validDay(day) || !SECTION_TIMES[block.start] || !SECTION_TIMES[block.end]) return new Set();
  const start = SECTION_ORDER.indexOf(block.start), end = SECTION_ORDER.indexOf(block.end);
  if (start > end) return new Set();
  return new Set(SECTION_ORDER.slice(start, end + 1).map((section) => day + ":" + section));
}
export function overlaps(a, b) {
  const x = meetingSlots(a), y = meetingSlots(b);
  return [...x].some((slot) => y.has(slot));
}
export function conflictsWith(course, courses, busyBlocks = [], excludeId = null) {
  const incoming = meetingSlots(course);
  const others = (courses || []).filter((other) => String(other.id) !== String(excludeId ?? course.id)
    && [...meetingSlots(other)].some((slot) => incoming.has(slot)));
  const busy = (busyBlocks || []).filter((block) => [...busySlots(block)].some((slot) => incoming.has(slot)));
  return { courses: others, busy };
}
export function scheduleStats(courses, busyBlocks = []) {
  const planned = courses || [];
  const occupied = new Set();
  const conflicts = new Set();
  const unknown = [];
  let credits = 0;
  for (const c of planned) {
    credits += Number(c.credits_number ?? c.credits) || 0;
    const slots = meetingSlots(c);
    if (!slots.size || (c.meetings || []).some((m) => !m.weekday || !(m.sections || []).length)) {
      unknown.push(c);
    }
    for (const slot of slots) {
      if (occupied.has(slot)) conflicts.add(slot);
      occupied.add(slot);
    }
  }
  for (const block of busyBlocks) {
    for (const slot of busySlots(block)) {
      if (occupied.has(slot)) conflicts.add(slot);
    }
  }
  let gaps = 0, days = 0;
  for (let day = 1; day <= 7; day++) {
    const indices = SECTION_ORDER.map((section, i) => occupied.has(day + ":" + section) ? i : -1).filter((i) => i >= 0);
    if (indices.length) { days++; gaps += (indices.at(-1) - indices[0] + 1) - indices.length; }
  }
  return {
    courseCount: planned.length, credits: Math.round(credits * 10) / 10,
    weeklySections: occupied.size, gapSections: gaps, conflictSlots: conflicts.size,
    classDays: days, unknownCount: unknown.length
  };
}
export function timetableMatrix(courses, busyBlocks = [], days = [1,2,3,4,5,6,7]) {
  const raw = new Map();
  for (const day of days) {
    for (const section of SECTION_ORDER) {
      const slot = day + ":" + section;
      const items = [];
      for (const course of courses || []) {
        if (meetingSlots(course).has(slot)) items.push({type:"course", id:String(course.id), data:course});
      }
      for (const block of busyBlocks || []) {
        if (busySlots(block).has(slot)) items.push({type:"busy", id:String(block.id), data:block});
      }
      raw.set(slot, items);
    }
  }
  const grouped = new Map();
  for (const day of days) {
    let index = 0;
    while (index < SECTION_ORDER.length) {
      const section = SECTION_ORDER[index];
      const items = raw.get(day + ":" + section) || [];
      const key = items.map((item) => item.type + ":" + item.id).sort().join("|");
      let span = 1;
      if (items.length) {
        while (index + span < SECTION_ORDER.length) {
          const nextItems = raw.get(day + ":" + SECTION_ORDER[index+span]) || [];
          const nextKey = nextItems.map((item) => item.type + ":" + item.id).sort().join("|");
          if (key !== nextKey) break;
          span++;
        }
      }
      grouped.set(day + ":" + section, {items, span, start: true});
      for (let j = 1; j < span; j++) grouped.set(day + ":" + SECTION_ORDER[index + j], {start:false});
      index += span;
    }
  }
  return grouped;
}
export function comparePlans(a,b) {
  const sa=scheduleStats(a.courses,a.busyBlocks),sb=scheduleStats(b.courses,b.busyBlocks);
  const aa=new Map(a.courses.map((c)=>[String(c.id),c.name]));
  const bb=new Map(b.courses.map((c)=>[String(c.id),c.name]));
  return {a:sa,b:sb,onlyA:[...aa].filter(([id])=>!bb.has(id)).map(([,name])=>name),
    onlyB:[...bb].filter(([id])=>!aa.has(id)).map(([,name])=>name)};
}
export function safeCourse(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  if (c.id == null || typeof c.name !== "string") return null;
  const course={};
  for (const k of ["id","name","name_en","course_code","department","division","grade","class_group","teacher",
    "credits","credits_number","required_elective","outline_url","teaching_language","detail_indexed"]) {
    if (c[k] !== undefined) course[k]=c[k];
  }
  course.meetings=Array.isArray(c.meetings) ? c.meetings.slice(0,20).filter((m)=>m&&typeof m==="object")
    .map((m)=>({weekday:m.weekday,sections:Array.isArray(m.sections)?m.sections.filter((x)=>SECTION_TIMES[x]).slice(0,15):[],
      room:typeof m.room==="string"?m.room:"",section_raw:typeof m.section_raw==="string"?m.section_raw:""})) : [];
  return course;
}
export function validateBackup(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.plans) || !payload.plans.length || payload.plans.length > 80) {
    throw Error("備份格式不正確，或沒有有效課表方案");
  }
  const plans=payload.plans.map((p, i)=>{
    if (!p || !Array.isArray(p.courses) || p.courses.length > 200) throw Error("第 "+(i+1)+" 個方案內容不正確");
    const courses=p.courses.map(safeCourse);
    if (courses.some((x)=>!x)) throw Error("備份包含無效課程資料");
    const blocks=Array.isArray(p.busyBlocks) ? p.busyBlocks : [];
    if (blocks.length>100) throw Error("忙碌時段數量超出限制");
    for (const block of blocks) if (!block || !busySlots(block).size || typeof block.label!=="string") throw Error("忙碌時段格式不正確");
    return {
      id:String(p.id||"backup-"+i),name:String(p.name||"方案 "+(i+1)).slice(0,70),
      termKey:typeof p.termKey==="string"?p.termKey:null,
      courses, busyBlocks:blocks.map((b,i)=>({id:String(b.id||"block-"+i),weekday:Number(b.weekday),
        start:b.start,end:b.end,label:b.label.slice(0,70)}))
    };
  });
  return {schemaVersion:SCHEMA_VERSION,academicYear:payload.academicYear??null,semester:payload.semester??null,
    activePlanId:String(payload.activePlanId||plans[0].id),plans};
}
export function toLocalDate(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateString))) return null;
  const d=new Date(dateString+"T00:00:00");
  return Number.isNaN(d.valueOf())?null:d;
}
export function escapeICS(value) {
  return String(value??"").replace(/\\/g,"\\\\").replace(/\r?\n/g,"\\n").replace(/,/g,"\\,").replace(/;/g,"\\;");
}
export function createICS(courses, {semesterStart, semesterWeeks, stamp="20260101T000000Z"}={}) {
  const start=toLocalDate(semesterStart), weeks=Number(semesterWeeks);
  if(!start || !Number.isInteger(weeks) || weeks<1 || weeks>30) throw Error("尚無可靠的開學日期或學期週數，無法匯出行事曆");
  const lines=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//FJU Course Planner//ZH-TW","CALSCALE:GREGORIAN","METHOD:PUBLISH"];
  let exported=0,skipped=0;
  const pad=(v)=>String(v).padStart(2,"0");
  const fmt=(d,t)=>String(d.getFullYear())+pad(d.getMonth()+1)+pad(d.getDate())+"T"+t.replace(":","")+"00";
  for(const course of courses){
    const meetings=course.meetings||[];
    if(!meetings.length) {skipped++;continue;}
    let created=0;
    for(const m of meetings) {
      const day=Number(m.weekday), parts=(m.sections||[]).filter((s)=>SECTION_TIMES[s]);
      if(!validDay(day)||!parts.length)continue;
      const sorted=[...new Set(parts)].sort((a,b)=>SECTION_ORDER.indexOf(a)-SECTION_ORDER.indexOf(b));
      let group=[];
      const flush=()=>{
        if(!group.length)return;
        const first=group[0],last=group.at(-1);
        const date=new Date(start);
        date.setDate(date.getDate()+(day-1 + (7-start.getDay()+1)%7)%7);
        // Align to the first requested weekday on or after semesterStart.
        const delta=(day - (start.getDay()||7)+7)%7;
        date.setTime(start.getTime());date.setDate(start.getDate()+delta);
        const startTime=SECTION_TIMES[first][0],endTime=SECTION_TIMES[last][1];
        lines.push("BEGIN:VEVENT","UID:fju-"+escapeICS(course.id)+"-"+day+"-"+first+"@course-planner",
          "DTSTAMP:"+stamp,"DTSTART;TZID=Asia/Taipei:"+fmt(date,startTime),
          "DTEND;TZID=Asia/Taipei:"+fmt(date,endTime),
          "RRULE:FREQ=WEEKLY;COUNT="+weeks,
          "SUMMARY:"+escapeICS(course.name),"LOCATION:"+escapeICS(m.room||""),
          "DESCRIPTION:"+escapeICS((course.teacher||"")+" "+(course.course_code||"")),"END:VEVENT");
        exported++;created++;group=[];
      };
      for(const sec of sorted) {
        if(group.length && SECTION_ORDER.indexOf(sec)!==SECTION_ORDER.indexOf(group.at(-1))+1)flush();
        group.push(sec);
      }
      flush();
    }
    if(!created)skipped++;
  }
  lines.push("END:VCALENDAR");
  return {content:lines.join("\r\n")+"\r\n",exported,skipped};
}
