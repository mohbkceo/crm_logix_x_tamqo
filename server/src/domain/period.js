import { assert } from "../errors.js";
const DAY = 86400000,
  OFFSET = 3600000;
export function dayStart(now = new Date()) {
  const d = new Date(+now + OFFSET);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - OFFSET,
  );
}
export function dateKey(date) {
  return new Date(+new Date(date) + OFFSET).toISOString().slice(0, 10);
}
export function reportingRange(query = {}, now = new Date()) {
  const today = dayStart(now),
    endToday = new Date(+today + DAY),
    d = new Date(+today + OFFSET),
    y = d.getUTCFullYear(),
    m = d.getUTCMonth();
  let start,
    end = endToday;
  switch (query.period || "30d") {
    case "today":
      start = today;
      break;
    case "yesterday":
      start = new Date(+today - DAY);
      end = today;
      break;
    case "week":
      start = new Date(+today - ((d.getUTCDay() + 6) % 7) * DAY);
      break;
    case "7d":
      start = new Date(+endToday - 7 * DAY);
      break;
    case "30d":
      start = new Date(+endToday - 30 * DAY);
      break;
    case "month":
      start = new Date(Date.UTC(y, m, 1) - OFFSET);
      break;
    case "lastMonth":
      start = new Date(Date.UTC(y, m - 1, 1) - OFFSET);
      end = new Date(Date.UTC(y, m, 1) - OFFSET);
      break;
    case "year":
      start = new Date(Date.UTC(y, 0, 1) - OFFSET);
      break;
    case "custom":
      assert(
        /^\d{4}-\d{2}-\d{2}$/.test(query.start || "") &&
          /^\d{4}-\d{2}-\d{2}$/.test(query.end || ""),
        "Custom dates are required.",
      );
      start = new Date(query.start + "T00:00:00+01:00");
      end = new Date(+new Date(query.end + "T00:00:00+01:00") + DAY);
      assert(
        Number.isFinite(+start) &&
          Number.isFinite(+end) &&
          dateKey(start) === query.start &&
          dateKey(new Date(+end - DAY)) === query.end,
        "Dates must be real calendar dates.",
      );
      break;
    default:
      assert(false, "Unknown reporting period.");
  }
  assert(
    Number.isFinite(+start) && Number.isFinite(+end) && end > start,
    "Invalid date range.",
  );
  assert(
    end - start <= 366 * 5 * DAY,
    "Choose a range no longer than five years.",
  );
  return {
    start,
    end,
    previousStart: new Date(+start - (end - start)),
    previousEnd: start,
    timeZone: "Africa/Algiers",
  };
}
