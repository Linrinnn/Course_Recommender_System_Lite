import assert from "node:assert/strict";
import { displayStudyLevel, departmentName, getLookupMatches } from "../static/filter-ui.mjs";

assert.equal(displayStudyLevel("master"), "碩士班");
assert.equal(displayStudyLevel("undergraduate"), "學士班／大學部");
assert.equal(displayStudyLevel("doctoral"), "博士班");
assert.equal(displayStudyLevel("unknown"), "未分類");
const departments = [
  {value:"01",label:"01｜中國文學系",count:35},
  {value:"02",label:"02｜歷史學系",count:30},
  {value:"03",label:"03｜哲學系",count:28},
  {value:"AT",label:"AT｜體育室",count:100},
];
assert.equal(departmentName(departments[0]), "中國文學系");
assert.equal(departmentName(departments[3]), "體育室");
assert.deepEqual(getLookupMatches(departments,"department","中國").map(x=>x.value),["01"]);
assert.deepEqual(getLookupMatches(departments,"department","01").map(x=>x.value),["01"]);
assert.equal(getLookupMatches(departments,"department","at")[0].displayLabel,"體育室");
const rooms = [
  {value:"1",label:"1",count:5},
  {value:"2",label:"2",count:7},
  {value:"A205",label:"A205",count:11},
  {value:"AA116",label:"AA116",count:3},
];
assert.deepEqual(getLookupMatches(rooms,"room","").map(x=>x.value),["A205","AA116"]);
assert.deepEqual(getLookupMatches(rooms,"room","1").map(x=>x.value),["1","AA116"]);
assert.deepEqual(getLookupMatches(rooms,"room","AA").map(x=>x.value),["AA116"]);
assert.deepEqual(getLookupMatches(rooms,"room","not-found").map(x=>x.value),[]);
assert.equal(getLookupMatches(departments,"department","",2).length,2);
console.log("Localized study levels and de-duplicated custom filter options passed");
