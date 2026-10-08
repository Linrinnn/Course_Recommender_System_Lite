/* Pure helpers for accessible course filter option rendering.
   Values remain unchanged for the existing API; only visible labels change. */
export const STUDY_LEVEL_LABELS = Object.freeze({
  undergraduate: "學士班／大學部",
  master: "碩士班",
  doctoral: "博士班",
  unknown: "未分類",
});

export function displayStudyLevel(raw) {
  return STUDY_LEVEL_LABELS[String(raw)] || String(raw || "未分類");
}
export function lookupText(value) {
  return String(value ?? "").trim().normalize("NFKC").toLocaleLowerCase("zh-TW");
}
export function departmentName(item) {
  const value = String(item?.value ?? "").trim();
  const label = String(item?.label ?? value).trim();
  const prefix = label.startsWith(value) ? label.slice(value.length) : "";
  return (value && /^[ ]*[|｜]/.test(prefix) ? prefix.replace(/^[ ]*[|｜][ ]*/, "") : label).trim() || value;
}
export function getLookupMatches(items, kind, query = "", limit = 45) {
  const input = lookupText(query);
  const seen = new Set();
  const results = [];
  for (const item of items || []) {
    const value = String(item?.value ?? "").trim();
    if (!value || seen.has(value)) continue;
    const label = kind === "department" ? departmentName(item) : String(item.label ?? value).trim();
    // Raw numeric room codes are ambiguous. Keep them searchable, but do not
    // crowd the default suggestions. Never silently remove underlying data.
    if (kind === "room" && !input && /^\d{1,2}$/.test(value)) continue;
    if (input && ![value,label,String(item.label ?? "")].some((s) => lookupText(s).includes(input))) continue;
    seen.add(value);
    results.push({...item, value, displayLabel:label});
  }
  results.sort((a,b) => {
    const exactA = input && (lookupText(a.value) === input || lookupText(a.displayLabel) === input) ? 1 : 0;
    const exactB = input && (lookupText(b.value) === input || lookupText(b.displayLabel) === input) ? 1 : 0;
    if (exactA !== exactB) return exactB - exactA;
    const startsA = input && lookupText(a.displayLabel).startsWith(input) ? 1 : 0;
    const startsB = input && lookupText(b.displayLabel).startsWith(input) ? 1 : 0;
    if (startsA !== startsB) return startsB - startsA;
    return a.displayLabel.localeCompare(b.displayLabel, "zh-TW", {numeric:true});
  });
  return results.slice(0,Math.max(1,limit));
}
