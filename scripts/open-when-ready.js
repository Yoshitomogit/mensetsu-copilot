/**
 * `npm run dev` 時に Next の起動を待ってから既定ブラウザで開く。
 * concurrently の子プロセスにしない（-k で他が止まるため）バックグラウンド実行用。
 *
 * Next が 3000 が塞がれていると 3001,3002… と避けることがあるため、
 * 優先ポート〜数ポートを順に試す。
 */
const http = require("http");
const { exec } = require("child_process");

const preferred = parseInt(String(process.env.PORT || process.env.NEXT_DEV_PORT || 3000), 10);
const skipPorts = new Set([
  parseInt(String(process.env.LIVE_PROXY_PORT || 3001), 10),
]);
/** @type {number[]} */
const tryPorts = [];
for (let p = preferred; p < preferred + 15; p++) {
  if (!skipPorts.has(p)) tryPorts.push(p);
}

const maxMs = 90_000;
const start = Date.now();

function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.error("[open-when-ready]", err.message);
  });
}

function probe(port) {
  const url = `http://localhost:${port}`;
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(url);
    });
    req.on("error", () => resolve(null));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function poll() {
  while (Date.now() - start < maxMs) {
    for (const port of tryPorts) {
      const url = await probe(port);
      if (url) {
        openBrowser(url);
        process.exit(0);
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  console.error(
    "[open-when-ready] タイムアウト: http://localhost:" + preferred + " 付近を手動で開いてください",
  );
  process.exit(0);
}

poll();
