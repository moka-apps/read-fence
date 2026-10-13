// Read Fence: while on, Read, Glob, Grep and Bash may not touch the folders that
// already enter the context as a listing (skills, rules, plugin cache). Off by
// default. The switch lives in read-fence.json inside the Claude config folder
// (CLAUDE_CONFIG_DIR, or ~/.claude when that is not set).
//
// Exempt even when on: the skill the model just invoked (its folder, learnt from
// skill.prompt), any CLAUDE.md, and the memory folders under the config folder.

const SETTINGS = "read-fence.json";
const BLOCKED_IN_CONFIG = ["plugins/cache", "skills", "rules"];
const BLOCKED_IN_PROJECT = [".claude/skills", ".claude/rules"];

// Folders of skills invoked this session (absolute, from the skill prompt's base dir line)
const invoked = new Set();

export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "read-fence",
      description: "Turn the read fence on or off, or show its state: on, off or status",
      argumentHint: "on|off|status",
    });
    return next(e);
  });

  on("command.run", ($, e, next) => runCommand($, e, next).catch(() => next(e)));

  on("skill.prompt", async ($, e, next) => {
    const m = /Base directory for this skill:\s*(\S+)/.exec(String(e.text ?? ""));
    if (m) invoked.add(m[1].replace(/\/+$/, ""));
    return next(e);
  });

  // The fence is a convenience: if it cannot decide, the call goes through.
  on("tool.call", { tool: ["Read", "Glob", "Grep", "Bash"] }, ($, e, next) => guard($, e, next).catch(() => next(e)));
}

async function runCommand($, e, next) {
  if (e.command !== "read-fence") return next(e);
  const arg = String(e.args ?? "").trim().toLowerCase();
  if (arg === "on" || arg === "off") {
    try {
      await setOn($, arg === "on");
    } catch {
      return { text: `read-fence could not save its setting, so it is still ${(await isOn($)) ? "on" : "off"}` };
    }
    return { text: `read-fence ${arg}` };
  }
  return { text: `read-fence is ${(await isOn($)) ? "on" : "off"}` };
}

async function guard($, e, next) {
  if (!(await isOn($))) return next(e);
  const home = await $.env.get("HOME");
  const config = await configDir($);
  const root = await $.session.root();
  const cwd = await $.session.cwd();
  for (const p of await touched($, e, cwd, home)) {
    const why = await blocked($, p, config, root);
    if (why) {
      return {
        deny: `Read Fence refused ${e.tool} on ${p}: ${why}. The fence is on (/read-fence off lifts it). Skill folders enter the context as name and description already; invoke a skill with the Skill tool instead of reading its folder.`,
      };
    }
  }
  return next(e);
}

async function configDir($) {
  const set = await $.env.get("CLAUDE_CONFIG_DIR");
  const dir = set || `${await $.env.get("HOME")}/.claude`;
  return dir.replace(/\/+$/, "");
}

async function isOn($) {
  try {
    return JSON.parse(await $.fs.read(`${await configDir($)}/${SETTINGS}`)).on === true;
  } catch {
    return false;
  }
}

async function setOn($, on) {
  await $.fs.write(`${await configDir($)}/${SETTINGS}`, JSON.stringify({ on }) + "\n");
}

/** The absolute paths a call reaches, as spelled. */
async function touched($, e, cwd, home) {
  const abs = (p) => (p.startsWith("/") ? p : `${cwd}/${p}`);
  if (e.tool === "Read") return [abs(String(e.file_path ?? ""))];
  if (e.tool === "Glob" || e.tool === "Grep") {
    const base = abs(String(e.path ?? "."));
    const out = [base];
    const pat = String(e.pattern ?? "");
    // A Glob pattern can reach a folder by itself, absolute or relative to the search path.
    if (e.tool === "Glob" && pat) out.push(pat.startsWith("/") ? pat.split("*")[0] : `${base}/${pat.split("*")[0]}`);
    return out;
  }
  // Bash: every absolute or ~ path spelled in the command line
  const command = String(e.command ?? "").replace(/\$\{HOME\}|\$HOME/g, home);
  const found = command.match(/(?:~|\/)[\w./@-]+/g) ?? [];
  return found.map((p) => (p.startsWith("~") ? home + p.slice(1) : p));
}

/** Why `path` is fenced, or null. Spelled path decides exemptions; spelled and real path decide blocks. */
async function blocked($, path, config, root) {
  const under = (p, dir) => p === dir || p.startsWith(dir + "/");
  if (/(^|\/)CLAUDE\.md$/.test(path)) return null;
  if (path === `${config}/${SETTINGS}`) return null;
  if (/\/projects\/[^/]+\/memory(\/|$)/.test(path) && under(path, config)) return null;
  for (const dir of invoked) if (under(path, dir)) return null;

  const real = (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath;
  for (const p of real && real !== path ? [path, real] : [path]) {
    for (const b of BLOCKED_IN_CONFIG) if (under(p, `${config}/${b}`)) return `${b} is fenced`;
    for (const b of BLOCKED_IN_PROJECT) if (under(p, `${root}/${b}`)) return `${b} is fenced`;
    for (const dir of invoked) if (under(p, dir)) return null;
  }
  return null;
}
