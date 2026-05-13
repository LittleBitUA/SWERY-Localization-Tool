// Тонкий launcher для Electron — гарантує, що ELECTRON_RUN_AS_NODE
// не успадковується від системного env. Без цього require("electron")
// у головному процесі повертає шлях до .exe, а не Electron API.

delete process.env.ELECTRON_RUN_AS_NODE;
const { spawn } = require("node:child_process");
const electronPath = require("electron");

const child = spawn(electronPath, ["."], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("Failed to launch Electron:", err);
  process.exit(1);
});
