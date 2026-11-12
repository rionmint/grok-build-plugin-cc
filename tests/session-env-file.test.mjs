// rionmint fork: SessionStart fires again on every resume and compaction, and Claude Code
// inlines CLAUDE_ENV_FILE into every Bash call. Appending made the file grow until the Bash
// tool failed on Windows (ENAMETOOLONG / "-c: unexpected EOF"). These tests pin the rewrite
// that keeps only the last export of every variable.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_HOOK = path.join(ROOT, "plugins", "grok-build", "scripts", "session-lifecycle-hook.mjs");

function startSession(envFile, repo, sessionId, pluginDataDir) {
  return run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: pluginDataDir },
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId, transcript_path: path.join(repo, "s.jsonl"), cwd: repo })
  });
}

test("repeated SessionStart keeps one export per variable with the latest value", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  const pluginDataDir = makeTempDir();
  fs.writeFileSync(envFile, "", "utf8");

  for (let i = 0; i < 30; i += 1) {
    const result = startSession(envFile, repo, `sess-${i}`, pluginDataDir);
    assert.equal(result.status, 0, result.stderr);
  }

  const lines = fs.readFileSync(envFile, "utf8").split("\n").filter(Boolean);
  const names = lines.map((line) => /^export ([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1]);
  assert.equal(new Set(names).size, names.length, `duplicate exports: ${lines.join(" | ")}`);
  assert.ok(lines.includes("export GROK_CC_SESSION_ID='sess-29'"), lines.join(" | "));
  assert.ok(lines.includes(`export CLAUDE_PLUGIN_DATA='${pluginDataDir}'`), lines.join(" | "));
});

test("an env file already grown by older versions shrinks on the next SessionStart and keeps other lines", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  const pluginDataDir = makeTempDir();
  const grown = ["# kept as is"];
  for (let i = 0; i < 500; i += 1) {
    grown.push(`export GROK_CC_SESSION_ID='old-${i}'`, `export CLAUDE_PLUGIN_DATA='${pluginDataDir}'`);
  }
  fs.writeFileSync(envFile, `${grown.join("\n")}\n`, "utf8");

  const result = startSession(envFile, repo, "sess-new", pluginDataDir);
  assert.equal(result.status, 0, result.stderr);

  const lines = fs.readFileSync(envFile, "utf8").split("\n").filter(Boolean);
  assert.equal(lines[0], "# kept as is");
  assert.equal(lines.filter((line) => line.startsWith("export GROK_CC_SESSION_ID=")).length, 1);
  assert.ok(lines.includes("export GROK_CC_SESSION_ID='sess-new'"), lines.join(" | "));
  assert.equal(lines.filter((line) => line.startsWith("export CLAUDE_PLUGIN_DATA=")).length, 1);
  assert.ok(fs.statSync(envFile).size < 1024, `still ${fs.statSync(envFile).size} bytes`);
});
