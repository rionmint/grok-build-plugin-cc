#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { claimJobTerminal, loadState, resolveStateFile, saveState } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveJobKillTargets, SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  // rionmint fork change 2026-11-12 (see NOTICE):
  // SessionStart fires on every resume and compaction and the host inlines this file
  // into every Bash call, so appending made the file grow until Bash failed
  // (ENAMETOOLONG / "-c: unexpected EOF"). The file is this hook's own, so each write
  // keeps only the last export of every variable - same environment, bounded size.
  const envFile = process.env.CLAUDE_ENV_FILE;
  const line = `export ${name}=${shellEscape(value)}`;
  let current = "";
  try {
    current = fs.readFileSync(envFile, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const entries = current.split(/\r?\n/).filter((entry) => entry !== "");
  entries.push(line);
  const exportedName = (entry) => /^export ([A-Za-z_][A-Za-z0-9_]*)=/.exec(entry)?.[1] ?? null;
  const lastIndex = new Map();
  entries.forEach((entry, index) => {
    const variable = exportedName(entry);
    if (variable) {
      lastIndex.set(variable, index);
    }
  });
  const kept = entries.filter((entry, index) => {
    const variable = exportedName(entry);
    return variable === null || lastIndex.get(variable) === index;
  });
  const next = `${kept.join("\n")}\n`;
  if (next !== current) {
    fs.writeFileSync(envFile, next, "utf8");
  }
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const sessionJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (sessionJobs.length === 0) {
    return;
  }

  for (const job of sessionJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (stillRunning) {
      try {
        claimJobTerminal(workspaceRoot, job.id, "cancelled", {
          errorMessage: "Stopped by session end.",
          phase: "cancelled",
          pid: null,
          agentPid: null,
          bridgePid: null
        });
      } catch {
      }

      const killTargets = resolveJobKillTargets(job);
      for (const pid of killTargets) {
        try {
          terminateProcessTree(pid);
        } catch {
        }
      }
    }
  }

  const nextState = loadState(workspaceRoot);
  saveState(workspaceRoot, {
    ...nextState,
    jobs: nextState.jobs.filter((job) => job.sessionId !== sessionId)
  });
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
