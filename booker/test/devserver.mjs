// Starts `wrangler dev` for the end-to-end tests on a fresh local D1, and stops it (the whole
// process tree: wrangler leaves workerd children behind if only npx is killed). From
// sat-fordhamprep (site/test/devserver.mjs).
import { spawn, execSync } from "node:child_process";
import { mkdirSync, rmSync, openSync, readFileSync } from "node:fs";

const SITE = new URL("..", import.meta.url);

/** Cloudflare's published Turnstile testing secrets (public, not credentials). */
export const PASS_SECRET = "1x0000000000000000000000000000000AA";
export const FAIL_SECRET = "2x0000000000000000000000000000000AA";

/** One dev server. `vars` override wrangler.jsonc's; each server has its own D1 and log. */
export function devServer({ name = "e2e", port = Number(process.env.E2E_PORT ?? 8798), vars = {} } = {}) {
  const state = `.wrangler/${name}-state`;
  const logUrl = new URL(`../.wrangler/${name}-dev.log`, import.meta.url);
  const wrangler = (args) => execSync(`npx wrangler ${args}`, { cwd: SITE, stdio: "pipe" });
  const sql = (q) => {
    const run = () => wrangler(`d1 execute meeting-booker --local --persist-to ${state} --command "${q}"`);
    try { return run(); } catch (e) {
      if (!/internal error/.test(String(e.stderr ?? e.message))) throw e;
      return run();
    }
  };
  let child = null;
  const stop = () => {
    if (!child) return;
    try {
      if (process.platform === "win32") execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
      else process.kill(-child.pid, "SIGTERM");
    } catch { /* already gone */ }
    child = null;
  };

  return {
    base: `http://localhost:${port}`,
    log: () => readFileSync(logUrl, "utf8"),
    sql,
    rows(q) {
      const out = sql(q).toString();
      return JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1))[0].results;
    },
    async start() {
      rmSync(new URL(`../${state}`, import.meta.url), { recursive: true, force: true });
      mkdirSync(new URL("../.wrangler", import.meta.url), { recursive: true });
      wrangler(`d1 migrations apply meeting-booker --local --persist-to ${state}`);
      const out = openSync(logUrl, "w");
      // Turnstile uses Cloudflare's published testing keys: this secret passes any token, as
      // solved on example.com. No calendar feed: CAL_ICS_URL is unset, so it is skipped.
      const varArgs = Object.entries({ TURNSTILE_SITEKEY: "1x00000000000000000000AA", TURNSTILE_SECRET: PASS_SECRET,
        TURNSTILE_HOSTNAMES: "example.com", ...vars }).flatMap(([k, v]) => ["--var", `"${k}:${v}"`]);
      child = spawn(["npx", "wrangler", "dev", "--port", String(port), "--persist-to", state, ...varArgs,
        "--show-interactive-dev-session=false"].join(" "),
        { cwd: SITE, stdio: ["ignore", out, out], shell: true, detached: process.platform !== "win32" });
      for (let i = 0; i < 120; i++) {
        if (readFileSync(logUrl, "utf8").includes("Ready on")) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      stop();
      throw new Error(`wrangler dev did not start; see .wrangler/${name}-dev.log`);
    },
    stop,
  };
}
