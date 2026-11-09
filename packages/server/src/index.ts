#!/usr/bin/env node
// Bare ingest worker entry point (no App Server, no data-root setup): for
// development and the integration test. Operators run `memmem-server start`,
// which starts the App Server and runs this worker in-process.
import { errorMessage, log } from "./log.js";
import { Worker } from "./worker.js";

const worker = new Worker();
let signals = 0;

function onSignal(sig: NodeJS.Signals): void {
  signals += 1;
  if (signals > 1) {
    log("warn", "worker_forced_exit", { signal: sig });
    process.exit(130);
  }
  log("info", "worker_stopping", { signal: sig });
  worker.stop();
  // Do not hang forever on an in-flight turn.
  setTimeout(() => {
    log("warn", "worker_stop_timeout", {});
    process.exit(143);
  }, 30_000).unref();
}

process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);
process.on("SIGUSR2", () => worker.wake());
process.on("unhandledRejection", (reason) => {
  log("error", "unhandled_rejection", { error: errorMessage(reason) });
});

log("info", "worker_start", { pid: process.pid, node: process.version, once: process.env.MEMMEM_ONCE === "1" });
worker
  .run()
  .then((code) => {
    log("info", "worker_exit", { code });
    process.exit(code);
  })
  .catch((err) => {
    log("error", "worker_crashed", { error: errorMessage(err) });
    process.exit(1);
  });
