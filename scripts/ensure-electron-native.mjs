import { spawnSync } from "node:child_process";
import path from "node:path";

const projectRoot = process.cwd();
const electronExecutable = path.join(
  projectRoot,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const rebuildExecutable = path.join(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-rebuild.cmd" : "electron-rebuild",
);

function checkNativeModule() {
  return spawnSync(
    electronExecutable,
    [
      "-e",
      "const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('select 1').get();db.close();",
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
    },
  );
}

let check = checkNativeModule();
if (check.status === 0) process.exit(0);

console.log("正在为当前 Electron 版本修复本机数据库模块，请稍候……");
const rebuild = spawnSync(rebuildExecutable, ["-f", "-w", "better-sqlite3"], {
  cwd: projectRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (rebuild.status !== 0) {
  console.error("better-sqlite3 Electron 重编译失败。");
  process.exit(rebuild.status ?? 1);
}

check = checkNativeModule();
if (check.status !== 0) {
  console.error(check.stderr || check.stdout || "better-sqlite3 仍无法由 Electron 加载。");
  process.exit(check.status ?? 1);
}

console.log("本机数据库模块修复完成。");
