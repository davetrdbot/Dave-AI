import { ConnectionConfig, Sandbox, SandboxException } from "@alibaba-group/opensandbox";

/**
 * Step 6/7 follow-up: real integration with the real Alibaba OpenSandbox
 * SDK (`@alibaba-group/opensandbox` -- confirmed as the correct package
 * in Step 1.3/6; note there is an UNRELATED npm package literally named
 * `opensandbox`, from a different project (diggerhq, E2B-compatible) --
 * do not confuse the two).
 *
 * This is a real client, not a stub -- but OpenSandbox is a client/server
 * product: it talks to a running OpenSandbox service (self-hosted via
 * their Docker compose, or a hosted instance with a real API key).
 * Neither exists in this environment, so the "real proof" available here
 * is a real, honest connection attempt and its real failure -- the same
 * methodology used for the AirLLM and DSH-sandbox attempts in Steps 5/6.
 * Full functional proof (create sandbox, run command, real result) needs
 * a real OpenSandbox deployment, which is an infrastructure decision for
 * you to make, not something to fake here.
 */

export interface OpenSandboxConfig {
  domain: string;
  apiKey: string;
}

export interface OpenSandboxAttempt {
  reachable: boolean;
  detail: string;
}

export async function attemptOpenSandboxConnection(config: OpenSandboxConfig): Promise<OpenSandboxAttempt> {
  const connectionConfig = new ConnectionConfig({ domain: config.domain, apiKey: config.apiKey });
  try {
    const sandbox = await Sandbox.create({ connectionConfig, image: "ubuntu", timeoutSeconds: 60 });
    await sandbox.kill();
    await sandbox.close();
    return { reachable: true, detail: "sandbox created and killed successfully" };
  } catch (err) {
    if (err instanceof SandboxException) {
      return { reachable: false, detail: `[${err.error?.code}] ${err.error?.message ?? ""}` };
    }
    return { reachable: false, detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

/** Real code execution via OpenSandbox -- only usable once attemptOpenSandboxConnection() reports reachable. */
export async function runCodeViaOpenSandbox(config: OpenSandboxConfig, command: string): Promise<{ stdout: string; stderr: string }> {
  const connectionConfig = new ConnectionConfig({ domain: config.domain, apiKey: config.apiKey });
  const sandbox = await Sandbox.create({ connectionConfig, image: "ubuntu", timeoutSeconds: 60 });
  try {
    const execution = await sandbox.commands.run(command);
    return {
      stdout: execution.logs.stdout.map((m) => m.text).join(""),
      stderr: execution.logs.stderr.map((m) => m.text).join(""),
    };
  } finally {
    await sandbox.kill();
    await sandbox.close();
  }
}
