import assert from "node:assert/strict";
import { build } from "esbuild";

const bundled = await build({
  entryPoints: ["src/services/weread.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node"
});
const { fetchWeReadBooks, fetchWeReadNotebooks } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

const readerLink = "https://weread.qq.com/web/reader/reader-id";
const deepLink = "https://weread.qq.com/web/bookDetail/detail-id";
const fixtures = [
  { bookId: "reader", title: "阅读链接", readerLink: ` ${readerLink} `, deepLink },
  { bookId: "detail", title: "详情链接", deepLink },
  { bookId: "blank-reader", title: "空阅读链接", readerLink: " ", deepLink },
  { bookId: "missing", title: "无链接" },
  { bookId: "blank", title: "空链接", readerLink: " ", deepLink: " " }
];
const requests = [];
const upgradeUrl = "https://cdn.weread.qq.com/skills/weread-skills.zip";
const upgrade = { message: "微信读书有可用更新", upgrade_url: upgradeUrl };
let upgradeInfo;
const reply = (data) => new Response(JSON.stringify({ ...data, upgrade_info: upgradeInfo }));

globalThis.fetch = async (url, init) => {
  assert.equal(url, "https://i.weread.qq.com/api/agent/gateway");
  const request = JSON.parse(init.body);
  requests.push(request);
  assert.equal(request.skill_version, "1.0.6");
  assert.equal(request.params, undefined);

  switch (request.api_name) {
    case "/shelf/sync":
      return reply({ books: fixtures });
    case "/book/getprogress":
      return reply({ book: { progress: 25 } });
    case "/user/notebooks":
      assert.equal(request.count, 100);
      return reply({ books: fixtures.map((book) => ({ book })), hasMore: 0 });
    default:
      throw new Error(`Unexpected API: ${request.api_name}`);
  }
};

const expectedUrls = [readerLink, deepLink, deepLink, undefined, undefined];
assert.deepEqual((await fetchWeReadBooks("wrk-test")).map((book) => book.url), expectedUrls);
assert.deepEqual((await fetchWeReadNotebooks("wrk-test")).map((book) => book.url), expectedUrls);
console.log("Shelf and notebook URLs prefer readerLink, fall back to deepLink and omit missing links");

upgradeInfo = upgrade;
requests.length = 0;
const notices = [];
const onUpgradeNotice = (notice) => notices.push(notice);
const shelf = await fetchWeReadBooks("wrk-test", { onUpgradeNotice });
assert.deepEqual(shelf.map((book) => book.url), expectedUrls);
assert.ok(shelf.every((book) => book.progress === 25));
const notebooks = await fetchWeReadNotebooks("wrk-test", onUpgradeNotice);
assert.deepEqual(notebooks.map((book) => book.url), expectedUrls);
assert.deepEqual([...new Set(notices)], [`${upgrade.message}（${upgradeUrl}）`]);
assert.deepEqual(requests.map((request) => request.api_name), [
  "/shelf/sync", ...fixtures.map(() => "/book/getprogress"), "/user/notebooks"
]);
console.log("Upgrade notices preserve shelf, progress and notebook data without retrying requests");

for (const empty of [{ books: [], hasMore: 0 }, { totalBookCount: 0, hasMore: 0 }]) {
  globalThis.fetch = async () => reply(empty);
  assert.deepEqual(await fetchWeReadNotebooks("wrk-test", onUpgradeNotice), []);
}
globalThis.fetch = async () => reply({ errcode: 0 });
await assert.rejects(fetchWeReadBooks("wrk-test"), /未返回业务数据/);

for (const [status, errcode] of [[200, -1], [403, 0]]) {
  globalThis.fetch = async () => new Response(JSON.stringify({
    errcode, errmsg: "访问失败", upgrade_info: upgrade
  }), { status });
  notices.length = 0;
  await assert.rejects(fetchWeReadNotebooks("wrk-test", onUpgradeNotice), /访问失败/);
  assert.deepEqual(notices, []);
}
console.log("HTTP and gateway errors take precedence over upgrade notices");
