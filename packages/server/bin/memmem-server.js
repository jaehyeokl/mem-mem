#!/usr/bin/env node
import("../dist/cli.js").then((m) => m.main(process.argv.slice(2))).then(
  (code) => {
    if (typeof code === "number") process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`memmem-server: ${err?.stack ?? err}\n`);
    process.exit(1);
  },
);
