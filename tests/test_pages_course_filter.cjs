// Exercise the actual Pages API interception with an in-memory catalog.
// No network or browser dependencies required.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const fixture = {
  meta: { academic_year: 115, semester: 1, course_count: 4, detail_indexed: 0 },
  facets: {},
  courses: [
    { id: "1", name: "A", grade: 1, class_group: "甲", department: "資工系", credits_number: 3, meetings: [{ weekday: 1, sections: ["D1", "D2"], room: "A101" }] },
    { id: "2", name: "B", grade: 2, class_group: "乙", department: "資工系", credits_number: 3, meetings: [{ weekday: 2, sections: ["D1"], room: "A101" }] },
    { id: "3", name: "C", grade: 3, class_group: "乙", department: "資工系", credits_number: 3, meetings: [{ weekday: 1, sections: ["D3"], room: "B202" }] },
    { id: "4", name: "D", grade: 1, class_group: "甲", department: "其他系", credits_number: 3, meetings: [] },
  ],
};
global.location = { href: "https://example.github.io/Course_Recommender_System_Lite/" };
global.document = { baseURI: global.location.href };
global.window = {
  fetch: async () => new Response(JSON.stringify(fixture), { status: 200 }),
};
vm.runInThisContext(
  fs.readFileSync(path.join(__dirname, "../static/pages-api.js"), "utf-8"),
  { filename: "static/pages-api.js" }
);

(async () => {
  const url = "/api/courses?exclude_slots=1%3AD1%2C1%3AD2&page_size=2";
  const response = await window.fetch(url);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.total, 3);
  assert.equal(result.total_pages, 2);
  assert.deepEqual(result.items.map(x => x.id), ["2", "3"]);
  const second = await (await window.fetch(url + "&page=2")).json();
  assert.deepEqual(second.items.map(x => x.id), ["4"]);
  const next = await (await window.fetch("/api/courses?exclude_slots=2%3AD1")).json();
  assert.deepEqual(next.items.map(x => x.id), ["1", "3", "4"]);
  const selected = await (await window.fetch("/api/courses?grades=1%2C2&weekdays=1%2C2&class_group=%E4%B9%99")).json();
  assert.deepEqual(selected.items.map(x => x.id), ["2"]);
  const options = await (await window.fetch("/api/filter-options?department=%E8%B3%87%E5%B7%A5%E7%B3%BB&grades=2")).json();
  assert.deepEqual(options.grades.map(x => x.value), ["1", "2", "3"]);
  assert.deepEqual(options.classes.map(x => x.value), ["乙"]);
  // A course meeting on Monday D1 and Tuesday D5 is NOT a Monday D5 class.
  fixture.courses[0].meetings.push({ weekday: 2, sections: ["D5"], room: "A101" });
  const sameMeeting = await (await window.fetch("/api/courses?weekdays=1&sections=D5")).json();
  assert.equal(sameMeeting.total, 0);
  console.log("Pages linked filters, multi-grade/day and same-meeting matching passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
