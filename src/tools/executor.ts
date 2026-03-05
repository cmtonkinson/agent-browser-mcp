import { spawn } from "child_process";

// Environment variable for agent-browser executable path
const AGENT_BROWSER_PATH = process.env.AGENT_BROWSER_PATH || "agent-browser";

interface ExecOptions {
  [key: string]: unknown;
}

/**
 * Build the argv array for a given MCP command + options, matching the
 * agent-browser CLI's actual calling conventions:
 *
 *   open <url>                        (was: navigate --url)
 *   back / forward / reload           (was: go_back / go_forward)
 *   click <sel>                       (positional, not --selector)
 *   fill <sel> <text>                 (two positionals)
 *   type <sel> <text>                 (two positionals)
 *   hover <sel>
 *   press <key>
 *   scroll <dir> [px]
 *   select <sel> <val>
 *   check <sel>
 *   uncheck <sel>
 *   get text|html|url|title [sel]     (subcommand style)
 *   get attr <name> <sel>             (attribute special case)
 *   is visible|enabled|checked <sel>  (subcommand style)
 *   snapshot                          (no args; --interactive added by default)
 *   screenshot [path]
 *   pdf <path>
 *   eval <js>
 *   wait <sel|ms>
 *   cookies get|set|clear
 *   console
 *   network requests
 *   set viewport <w> <h>              (new_session viewport)
 */
function buildArgs(command: string, options: ExecOptions): string[] {
  const o = options as Record<string, unknown>;

  switch (command) {
    // ── Navigation ────────────────────────────────────────────────────────────
    case "navigate":
      return ["open", String(o.url)];

    case "go_back":
      return ["back"];

    case "go_forward":
      return ["forward"];

    case "reload":
      return ["reload"];

    // ── Interaction ───────────────────────────────────────────────────────────
    case "click":
      return ["click", String(o.selector)];

    case "fill":
      return ["fill", String(o.selector), String(o.value)];

    case "type":
      return ["type", String(o.selector), String(o.text)];

    case "hover":
      return ["hover", String(o.selector)];

    case "press":
      return ["press", String(o.key)];

    case "scroll": {
      const args = ["scroll", String(o.direction)];
      if (o.amount != null) args.push(String(o.amount));
      if (o.selector != null) args.push("--selector", String(o.selector));
      return args;
    }

    case "select":
      return ["select", String(o.selector), String(o.value)];

    case "check":
      return ["check", String(o.selector)];

    case "uncheck":
      return ["uncheck", String(o.selector)];

    // ── Information retrieval ─────────────────────────────────────────────────
    case "get_text": {
      const args = ["get", "text"];
      if (o.selector != null) args.push(String(o.selector));
      return args;
    }

    case "get_html": {
      // agent-browser get html [selector]  (no --outer flag in CLI; inner is default)
      const args = ["get", "html"];
      if (o.selector != null) args.push(String(o.selector));
      return args;
    }

    case "get_attribute":
      // get attr <name> <selector>
      return ["get", "attr", String(o.attribute), String(o.selector)];

    case "get_url":
      return ["get", "url"];

    case "get_title":
      return ["get", "title"];

    case "snapshot":
      // Always request interactive-only compact snapshot for AI efficiency
      return ["snapshot", "--interactive", "--compact"];

    // ── Element state ─────────────────────────────────────────────────────────
    case "is_visible":
      return ["is", "visible", String(o.selector)];

    case "is_enabled":
      return ["is", "enabled", String(o.selector)];

    case "is_checked":
      return ["is", "checked", String(o.selector)];

    // ── Screenshot / PDF ──────────────────────────────────────────────────────
    case "screenshot": {
      const args = ["screenshot"];
      if (o.path != null) args.push(String(o.path));
      if (o.fullPage) args.push("--full");
      if (o.selector != null) args.push("--selector", String(o.selector));
      return args;
    }

    case "pdf":
      return ["pdf", String(o.path)];

    // ── Session management ────────────────────────────────────────────────────
    case "new_session": {
      // agent-browser set viewport <w> <h> creates an isolated context;
      // closest approximation since there is no explicit "new session" command.
      if (o.viewport != null) {
        const vp = o.viewport as { width: number; height: number };
        return ["set", "viewport", String(vp.width), String(vp.height)];
      }
      // No-op: just return version to confirm daemon is alive
      return ["--version"];
    }

    case "close_session":
      return ["close"];

    // ── Wait ──────────────────────────────────────────────────────────────────
    case "wait_for_selector": {
      const args = ["wait", String(o.selector)];
      if (o.timeout != null) args.push("--timeout", String(o.timeout));
      if (o.state != null) args.push("--state", String(o.state));
      return args;
    }

    case "wait_for_navigation": {
      const args = ["wait", "--load", "networkidle"];
      if (o.timeout != null) args.push("--timeout", String(o.timeout));
      return args;
    }

    // ── Cookies ───────────────────────────────────────────────────────────────
    case "get_cookies":
      return ["cookies", "get"];

    case "set_cookies":
      // Pass cookies as JSON via eval — CLI set is per-cookie and not batchable
      return [
        "eval",
        `(async () => {
          for (const c of ${JSON.stringify(o.cookies)}) {
            await page.context().addCookies([c]);
          }
        })()`,
      ];

    case "clear_cookies":
      return ["cookies", "clear"];

    // ── JavaScript ────────────────────────────────────────────────────────────
    case "evaluate":
      return ["eval", String(o.script)];

    // ── Console / Network ─────────────────────────────────────────────────────
    case "get_console":
      return ["console"];

    case "get_network":
      return ["network", "requests"];

    // ── Fallback: unknown command, pass through as-is ─────────────────────────
    default: {
      const args: string[] = [command];
      for (const [key, value] of Object.entries(o)) {
        if (value === undefined || value === null) continue;
        const flag = `--${key.replace(/([A-Z])/g, "-$1").toLowerCase()}`;
        if (typeof value === "boolean") {
          if (value) args.push(flag);
        } else if (Array.isArray(value) || typeof value === "object") {
          args.push(flag, JSON.stringify(value));
        } else {
          args.push(flag, String(value));
        }
      }
      return args;
    }
  }
}

/**
 * Execute an agent-browser command and return the result.
 */
export async function execBrowser(
  command: string,
  options: ExecOptions = {},
  sessionId?: string
): Promise<string> {
  const args = buildArgs(command, options);

  // Inject --session after the subcommand(s) but before any trailing args.
  // agent-browser accepts --session anywhere in the argv, so appending is safe.
  if (sessionId) {
    args.push("--session", sessionId);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(AGENT_BROWSER_PATH, args, {
      env: {
        ...process.env,
        ...(sessionId && { AGENT_BROWSER_SESSION: sessionId }),
      },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim() || "Command executed successfully");
      } else {
        reject(
          new Error(
            `agent-browser exited with code ${code}: ${stderr || stdout}`
          )
        );
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to execute agent-browser: ${err.message}`));
    });
  });
}

/**
 * Check if agent-browser is available.
 */
export async function checkAgentBrowser(): Promise<boolean> {
  try {
    await execBrowser("--version", {});
    return true;
  } catch {
    return false;
  }
}
