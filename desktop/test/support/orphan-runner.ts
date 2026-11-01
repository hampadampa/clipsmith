/**
 * Started by backend-manager.test.ts as a separate process: runs a BackendManager against the shim engine,
 * prints `READY <engine pid> <url>` and then waits. The test kills this process with SIGKILL (no clean-up
 * code gets to run) and checks that the engine notices and exits by itself.
 *
 *   node orphan-runner.ts <engineDir> <backendDir> <shimPath>
 */
import { BackendManager } from "../../src/main/backend-manager.ts";

const [engineDir, backendDir, shim] = process.argv.slice(2) as [string, string, string];

const manager = new BackendManager({
  engineDir,
  backendDir,
  getConfig: () => ({ whisperModel: "small", apiKey: null }),
  env: { ...process.env, CLIPSMITH_SHIM_DEBUG: "1" },
  commands: {
    check: () => ["-c", "import json; print(json.dumps({'ok': True, 'checks': []}))"],
    serve: (port, dataDir) => [shim, "--host", "127.0.0.1", "--port", String(port), "--data-dir", dataDir, "--exit-when-stdin-closes"],
  },
});

await manager.start();
const url = manager.url();
if (!url) {
  console.log("FAILED " + JSON.stringify(manager.info().problem));
  process.exit(1);
}
const env = (await (await fetch(`${url}/debug/env`)).json()) as { pid: number };
console.log(`READY ${env.pid} ${url}`);
setInterval(() => {}, 1000);
