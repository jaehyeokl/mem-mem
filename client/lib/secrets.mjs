// Best-effort secret redaction. Patterns are intentionally conservative; this is
// a safety net, not a guarantee (see README "Privacy").

export const SECRET_PATTERNS = [
  { type: "private_key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { type: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { type: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { type: "aws_access_key", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { type: "aws_secret_key", re: /(aws_?secret_?access_?key["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}/gi, keepGroup: 1 },
  { type: "api_key", re: /\bsk-(?:ant-|proj-|live-|test-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { type: "slack_token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { type: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: "password", re: /(\b(?:password|passwd|pwd)["']?\s*[:=]\s*)("[^"\n]{3,}"|'[^'\n]{3,}'|[^\s"',;&]{3,})/gi, keepGroup: 1 },
];

/** Redact one string. Mutates `counts` ({type: n}). */
export function redactString(text, counts = {}) {
  let out = text;
  for (const { type, re, keepGroup } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (...m) => {
      const match = m[0];
      if (match.includes("[REDACTED:")) return match;
      counts[type] = (counts[type] || 0) + 1;
      return (keepGroup ? m[keepGroup] : "") + `[REDACTED:${type}]`;
    });
  }
  return out;
}

/** Deep-redact every string value in a JSON-like value. Returns { value, counts, total }. */
export function redactDeep(value) {
  const counts = {};
  const walk = (v) => {
    if (typeof v === "string") return redactString(v, counts);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  const out = walk(value);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { value: out, counts, total };
}
