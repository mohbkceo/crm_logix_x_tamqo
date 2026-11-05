import { chromium, expect } from "@playwright/test";
import express from "express";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";

// Isolated presentation fixtures: no database, real accounts or courier calls.
const app = express();
app.use(express.static(path.resolve("client/dist")));
app.get("/{*path}", (_req, res) =>
  res.sendFile(path.resolve("client/dist/index.html")),
);
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [],
    mutations = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("409 (Conflict)"))
      errors.push(m.text());
  });
  const now = Date.now();
  const rows = [
    ["1293", "تاير فتح الدين", "PREPARING", 2250, 3, 1],
    ["1292", "Leban rafika", "AT_PRODUCTION", 3800, 2, 0],
    ["1291", "محمد", "PREPARING", 750, 1, 2],
    ["1290", "Moh Bk", "READY_TO_SHIP", 1200, 1, 0],
    ["1289", "Riad", "DELIVERED", 892.5, 4, 0],
    ["1288", "عميل باسم طويل لاختبار اتجاه النص", "PREPARING", 0, 0, 0],
    ["1287", "Missing total", "PREPARING", null, 1, 0],
  ].map(([id, name, stage, total, count, reports], i) => ({
    _id: id,
    orderNumber: "#" + id,
    customer: { name, phoneA: "0550123456" },
    items: count
      ? [{ name: "لوحة مخصصة", quantity: count, specifications: "Blue · 20cm" }]
      : [],
    totalOrderValue: total,
    createdAt: new Date(now - (i < 3 ? 2 : 5) * 86400000).toISOString(),
    note: i === 1 ? "يرجى الاتصال قبل التوصيل" : "",
    images:
      i < 2 ? [{ _id: "preview", url: `/api/order-media/${id}/preview` }] : [],
    revision: 4,
    tracking: {
      stage,
      openIssues: reports,
      criticalIssues: i === 2 ? 1 : 0,
      blockingIssues: 0,
      important: false,
      stageEnteredAt: new Date(now).toISOString(),
    },
    status: stage,
    displayStatus: stage,
    courierOwned: stage === "DELIVERED",
    allowedTargets:
      stage === "PREPARING"
        ? ["AT_PRODUCTION"]
        : stage === "AT_PRODUCTION"
          ? ["PREPARING", "READY_TO_SHIP"]
          : stage === "READY_TO_SHIP"
            ? ["AT_PRODUCTION"]
            : [],
    readiness: { canEnable: stage === "AT_PRODUCTION" },
    canViewOrder: true,
    canMarkImportant: true,
    responsible: { name: "فريق الإنتاج", url: "https://wa.me/213550123456" },
    creatorContact: { url: "https://wa.me/213550987654" },
    shipment: {
      agencyName: "ABEX",
      tracking: "ABEX-123",
      url: "https://example.com/tracking/ABEX-123",
    },
  }));
  let failNext = false;
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.pathname.startsWith("/api/order-media/")) {
      const portrait = url.pathname.includes("1292");
      return route.fulfill({
        contentType: "image/svg+xml",
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="${portrait ? 300 : 800}" height="${portrait ? 800 : 300}"><rect width="100%" height="100%" fill="#e1c9ab"/><circle cx="150" cy="150" r="90" fill="#527d75"/></svg>`,
      });
    }
    let data = {};
    if (url.pathname === "/api/auth/session")
      data = {
        user: {
          _id: "qa",
          name: "Layout QA",
          role: "SUPER_ADMIN",
          permissions: [],
          businessAccess: ["LOGIX"],
          operationalRoles: [],
        },
      };
    else if (url.pathname === "/api/tracking/employees") data = [];
    else if (url.pathname === "/api/tracking/issue-types")
      data = {
        items: [
          { _id: "issue", label: "ملاحظة العميل", defaultSeverity: "INFO" },
        ],
      };
    else if (/\/stage$/.test(url.pathname)) {
      mutations.push(req.postDataJSON());
      if (failNext) {
        failNext = false;
        return route.fulfill({
          status: 409,
          json: { error: { message: "تغير الطلب، يرجى المحاولة مجدداً" } },
        });
      }
      const o = rows.find((r) => url.pathname.includes("/" + r._id + "/"));
      assert.equal(req.postDataJSON().expectedRevision, o.revision);
      o.tracking.stage = req.postDataJSON().targetStage;
      o.revision++;
      o.allowedTargets =
        o.tracking.stage === "AT_PRODUCTION"
          ? ["PREPARING", "READY_TO_SHIP"]
          : [];
      o.readiness.canEnable = o.tracking.stage === "AT_PRODUCTION";
      data = o;
    } else if (/\/issues$/.test(url.pathname)) data = { items: [] };
    else if (url.pathname === "/api/tracking") {
      let items = rows.filter(
        (o) =>
          !url.searchParams.get("stage") ||
          o.tracking.stage === url.searchParams.get("stage"),
      );
      if (url.searchParams.get("search"))
        items = items.filter((o) =>
          o.customer.name.includes(url.searchParams.get("search")),
        );
      data = {
        items,
        total: items.length,
        page: 1,
        pages: 1,
        limit: 20,
        tagCounts: {},
      };
    }
    await route.fulfill({ json: data });
  });
  await page.goto(
    process.env.LAYOUT_URL ||
      `http://127.0.0.1:${server.address().port}/tracking`,
  );
  const first = page.getByRole("article", { name: "#1293", exact: true });
  await expect(first).toBeVisible();
  await expect(first.locator(".tracking-price")).toContainText("2,250");
  await expect(first.locator(".tracking-item-count")).toContainText("3 قطعة");
  await expect(first.locator(".tracking-created")).toHaveText("منذ 2 يوم");
  await expect(
    page
      .getByRole("article", { name: "#1288", exact: true })
      .locator(".tracking-price"),
  ).toHaveText("0 DA");
  await expect(
    page
      .getByRole("article", { name: "#1287", exact: true })
      .locator(".tracking-price"),
  ).toHaveText("—");
  const thumbnail = first.getByRole("button", {
    name: "تكبير صورة الطلب #1293",
    exact: true,
  });
  const portraitThumbnail = page.getByRole("button", {
    name: "تكبير صورة الطلب #1292",
    exact: true,
  });
  for (const thumb of [thumbnail, portraitThumbnail]) {
    await expect(thumb.locator("img")).toBeVisible();
    const box = await thumb.boundingBox();
    assert.equal(box.width, 40);
    assert.equal(box.height, 40);
  }
  await expect(
    page
      .getByRole("article", { name: "#1287", exact: true })
      .locator(".tracking-thumbnail-placeholder"),
  ).toBeVisible();
  await thumbnail.click();
  const enlarged = page.locator(".tracking-image-stage > img");
  await expect(enlarged).toBeVisible();
  await expect(enlarged).toHaveAttribute(
    "src",
    "/api/order-media/1293/preview",
  );
  await enlarged.click();
  await expect(page.locator(".tracking-image-overlay")).toHaveCount(0);
  await expect(thumbnail).toBeFocused();
  await thumbnail.focus();
  await page.keyboard.press("Enter");
  await expect(enlarged).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".tracking-image-overlay")).toHaveCount(0);
  const selectAll = page.getByRole("checkbox", {
    name: "تحديد كل الطلبات المؤهلة",
  });
  await selectAll.check();
  await expect(page.locator(".tracking-bulk")).toBeVisible();
  await selectAll.uncheck();
  await expect(page.locator(".tracking-bulk")).toHaveCount(0);
  const output = path.resolve(".local/qa/tracking-redesign");
  await mkdir(output, { recursive: true });
  await page.screenshot({
    path: path.join(output, "desktop.png"),
    fullPage: true,
  });
  for (const width of [390, 320, 760, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(first).toBeVisible();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      `No page overflow at ${width}`,
    );
    const thumbBox = await thumbnail.boundingBox();
    assert.equal(thumbBox.width, 40);
    assert.equal(thumbBox.height, 40);
    await thumbnail.click();
    await expect(enlarged).toBeVisible();
    await enlarged.click();
    await expect(page.locator(".tracking-image-overlay")).toHaveCount(0);
    const menu = first.locator("summary");
    await menu.click();
    const panel = page.locator(".tracking-order-menu");
    await expect(panel).toBeVisible();
    await expect
      .poll(
        async () => {
          const box = await panel.boundingBox();
          return box.x >= 0 && box.x + box.width <= width + 1;
        },
        { message: `Action menu fits at ${width}` },
      )
      .toBe(true);
    await expect(
      panel.getByRole("link", { name: "التواصل مع مُنشئ الطلب" }),
    ).toHaveAttribute("href", "https://wa.me/213550987654");
    await expect(
      panel.getByRole("link", { name: "عرض لدى شركة التوصيل" }),
    ).toHaveAttribute("href", "https://example.com/tracking/ABEX-123");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    if (width === 390)
      await page.screenshot({
        path: path.join(output, "mobile.png"),
        fullPage: true,
      });
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await first.locator(".tracking-stage-current").click();
  await expect(first.locator(".tracking-stage-current")).toHaveText(
    "قيد الإنتاج",
  );
  assert.equal(mutations[0].targetStage, "AT_PRODUCTION");
  failNext = true;
  await first.locator(".tracking-stage-current").click();
  await expect(page.getByRole("alert")).toContainText("تغير الطلب");
  await expect(first.locator(".tracking-stage-current")).toHaveText(
    "قيد الإنتاج",
  );
  await first.locator(".tracking-stage-current").click();
  await expect(first.locator(".tracking-stage-current")).toHaveText(
    "جاهز للشحن",
  );
  await expect(first.locator("button.tracking-stage-current")).toHaveCount(0);
  // Reversal is still available explicitly, but the status badge never reverses an order.
  await first.locator("summary").click();
  await page.keyboard.press("Escape");
  await first.getByRole("button", { name: "إبلاغ عن مشكلة" }).click();
  await expect(page.locator(".tracking-report-form")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "قيد التحضير", exact: true }).click();
  await expect(first).toHaveCount(0);
  await page.getByRole("button", { name: "الكل", exact: true }).click();
  await page.getByRole("textbox", { name: "البحث في الطلبات" }).fill("Leban");
  await expect(page.getByRole("article")).toHaveCount(1);
  assert.deepEqual(errors, []);
  console.log(
    "Tracking layout passed: totals, quantities, creation age, responsive menus, status progression, conflict recovery, reports, contacts, courier links and filters.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
