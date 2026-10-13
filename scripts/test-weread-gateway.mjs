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
let requireUpgrade = false;
const upgradeUrl = "https://cdn.weread.qq.com/skills/weread-skills.zip";

globalThis.fetch = async (url, init) => {
  assert.equal(url, "https://i.weread.qq.com/api/agent/gateway");
  const request = JSON.parse(init.body);
  requests.push(request);
  assert.equal(request.skill_version, "1.0.5");
  assert.equal(request.params, undefined);

  if (requireUpgrade) {
    return new Response(JSON.stringify({
      books: fixtures,
      upgrade_info: {
        message: "请立即从 upgrade_url 下载最新版",
        upgrade_url: upgradeUrl
      }
    }));
  }

  switch (request.api_name) {
    case "/shelf/sync":
      return new Response(JSON.stringify({ books: fixtures }));
    case "/book/getprogress":
      return new Response(JSON.stringify({ book: { progress: 0 } }));
    case "/user/notebooks":
      assert.equal(request.count, 100);
      return new Response(JSON.stringify({ books: fixtures.map((book) => ({ book })), hasMore: 0 }));
    default:
      throw new Error(`Unexpected API: ${request.api_name}`);
  }
};

const expectedUrls = [readerLink, deepLink, deepLink, undefined, undefined];
assert.deepEqual((await fetchWeReadBooks("wrk-test")).map((book) => book.url), expectedUrls);
assert.deepEqual((await fetchWeReadNotebooks("wrk-test")).map((book) => book.url), expectedUrls);
console.log("Shelf and notebook URLs prefer readerLink, fall back to deepLink and omit missing links");

requireUpgrade = true;
requests.length = 0;
for (const fetchBooks of [fetchWeReadBooks, fetchWeReadNotebooks]) {
  await assert.rejects(fetchBooks("wrk-test"), (error) => {
    assert.ok(error.message.startsWith("微信读书接口已暂停："));
    assert.ok(error.message.includes(upgradeUrl));
    return true;
  });
}
assert.deepEqual(requests.map((request) => request.api_name), ["/shelf/sync", "/user/notebooks"]);
console.log("Upgrade notices stop reading even when books are returned, and show the actual download URL");
