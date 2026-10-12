// Profile.ini（アプリ名・バージョンなどの定数）から src/profile.js を生成する。
// Workers は実行時に ini を読めないため、wrangler のビルド時と npm test の前に実行する。
// Profile.ini は著作者だけが変更する。このスクリプトは読み取りのみ。
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const ini = readFileSync(new URL("Profile.ini", root), "utf8");

const profile = {};
let section = null;
for (const raw of ini.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith(";")) continue;
  const head = line.match(/^\[(.+)\]$/);
  if (head) {
    section = profile[head[1]] = {};
  } else if (section && line.includes("=")) {
    const i = line.indexOf("=");
    section[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}

const out = `// このファイルは scripts/profile.mjs が Profile.ini から生成する。直接編集しない。
export default ${JSON.stringify(profile, null, 2)};
`;
writeFileSync(new URL("src/profile.js", root), out);
