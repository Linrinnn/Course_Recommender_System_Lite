import assert from "node:assert/strict";
import {
  SECTION_ORDER, meetingSlots, busySlots, overlaps, conflictsWith, scheduleStats,
  timetableMatrix, comparePlans, validateBackup, createICS, termKey
} from "../static/schedule-core.mjs";

const meeting=(weekday,sections,room="SF100")=>({weekday,sections,room});
const course=(id,name,grade,meetings,credits=3)=>({id,name,grade,meetings,credits_number:credits,teacher:"教授"});
const a=course("a","資料結構",2,[meeting(1,["D5","D6","D7"]),meeting(3,["D3"])],3);
const b=course("b","計算機概論",1,[meeting(1,["D6"])],2);
const c=course("c","資料分析",2,[meeting(2,["D5"])],3);
const unknown=course("unknown","實習",3,[],1);
const busy={id:"busy",weekday:1,start:"D7",end:"D8",label:"打工"};

assert.deepEqual([...meetingSlots(a)].sort(),["1:D5","1:D6","1:D7","3:D3"]);
assert.deepEqual([...busySlots(busy)],["1:D7","1:D8"]);
assert.equal(overlaps(a,b),true);
assert.equal(overlaps(a,c),false);
assert.deepEqual(conflictsWith(a,[a,b,c],[busy]).courses.map(x=>x.id),["b"]);
assert.equal(conflictsWith(a,[a,b,c],[busy]).busy.length,1);
const stats=scheduleStats([a,b,c,unknown],[busy]);
assert.equal(stats.courseCount,4);
assert.equal(stats.credits,9);
assert.equal(stats.weeklySections,5);
assert.equal(stats.conflictSlots,2);
assert.equal(stats.unknownCount,1);
assert.equal(stats.gapSections,0);
const matrix=timetableMatrix([a,c],[],[1,2]);
assert.equal(matrix.get("1:D5").span,3);
assert.equal(matrix.get("1:D6").start,false);
assert.equal(matrix.get("2:D5").span,1);
const matrixWithConflict=timetableMatrix([a,b],[],[1]);
assert.equal(matrixWithConflict.get("1:D5").span,1);
assert.equal(matrixWithConflict.get("1:D6").items.length,2);
assert.equal(matrixWithConflict.get("1:D7").span,1);
const comparison=comparePlans({courses:[a,b],busyBlocks:[]},{courses:[a,c],busyBlocks:[]});
assert.deepEqual(comparison.onlyA,["計算機概論"]);
assert.deepEqual(comparison.onlyB,["資料分析"]);
assert.equal(termKey(115,1),"115-1");
const backup=validateBackup({
  schemaVersion:1,academicYear:115,semester:1,activePlanId:"p1",
  plans:[{id:"p1",name:"方案",courses:[a],busyBlocks:[busy]}]
});
assert.equal(backup.schemaVersion,2);
assert.equal(backup.plans[0].courses[0].meetings[0].room,"SF100");
assert.equal(backup.plans[0].busyBlocks[0].label,"打工");
assert.throws(()=>validateBackup({plans:[{courses:[{}]}]}),/無效課程/);
assert.throws(()=>validateBackup({plans:[{courses:[],busyBlocks:[{weekday:9,start:"D1",end:"D2",label:"壞資料"}]}]}),/忙碌時段/);
const ics=createICS([a,c,unknown],{semesterStart:"2026-09-14",semesterWeeks:18});
assert.equal(ics.exported,3);
assert.equal(ics.skipped,1);
assert.ok(ics.content.includes("DTSTART;TZID=Asia/Taipei:20260914T134000"));
assert.ok(ics.content.includes("DTEND;TZID=Asia/Taipei:20260914T163000"));
assert.ok(ics.content.includes("RRULE:FREQ=WEEKLY;COUNT=18"));
assert.ok(!ics.content.includes("SUMMARY:實習"));
console.log("Timetable 2.0 core: conflicts, rowspan, stats, backups and ICS passed.");
