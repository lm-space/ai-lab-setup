import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("../", import.meta.url));
const children = [
  spawn("pnpm", ["exec", "tsx", "watch", "src/server/index.ts"], { cwd, stdio: "inherit", detached: true }),
  spawn("pnpm", ["exec", "vite"], { cwd, stdio: "inherit", detached: true }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }
  setTimeout(() => {
    for (const child of children) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    process.exit(code);
  }, 1000);
}
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop());
for (const child of children) {
  child.on("error", (error) => { console.error(error); stop(1); });
  child.on("exit", (code) => { if (!stopping) stop(code || 1); });
}
