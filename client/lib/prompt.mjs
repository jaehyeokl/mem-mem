// Interactive prompts (Node readline/promises). Only used when stdin and
// stdout are TTYs and --yes was not given; tests inject a scripted prompter.
import readline from "node:readline/promises";

/**
 * Returns a prompter { ask(question, default) -> Promise<string>, close() },
 * or null when prompting is not possible (non-TTY) or not wanted (--yes).
 */
export function createPrompter({ yes = false, input = process.stdin, output = process.stdout } = {}) {
  if (yes || !input.isTTY || !output.isTTY) return null;
  const rl = readline.createInterface({ input, output });
  return {
    async ask(question, def = "") {
      const a = (await rl.question(`${question}${def ? ` [${def}]` : ""}: `)).trim();
      return a || def;
    },
    close() { rl.close(); },
  };
}

/** Prompter that answers from a list (tests). Records the questions it was asked. */
export function scriptedPrompter(answers) {
  const queue = [...answers];
  const asked = [];
  return {
    asked,
    async ask(question, def = "") { asked.push(question); const a = queue.shift(); return a === undefined || a === "" ? def : a; },
    close() {},
  };
}

export const yesNo = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  if (["y", "yes", "true", "1", "예", "네", "응"].includes(s)) return true;
  if (["n", "no", "false", "0", "아니오", "아니요", "아니"].includes(s)) return false;
  return null;
};
