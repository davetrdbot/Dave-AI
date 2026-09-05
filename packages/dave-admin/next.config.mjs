/** @type {import('next').NextConfig} */
const nextConfig = {
  // Real root cause of the "dev-server hydration bug" flagged in the
  // verification pass: it isn't a proxy/environment quirk at all --
  // Next.js 16's dev server blocks cross-origin access to dev resources
  // (the /_next/hmr websocket included) by default, and treats 127.0.0.1
  // as a different origin from itself. A raw TCP handshake to the HMR
  // endpoint succeeds fine (confirmed); a real browser's request gets a
  // deliberate rejection instead of a completed upgrade, which surfaces
  // as an opaque "invalid HTTP response" client-side. This is Next's own
  // documented fix (dev server log names it verbatim).
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // @dave/sandbox pulls in DSH's local sandbox driver, which loads native
  // addons (koffi FFI bindings, a landlock-run binary launcher) at runtime.
  // Those aren't JS modules Turbopack can bundle -- they need to stay a
  // plain require()/dynamic import resolved by Node at request time.
  serverExternalPackages: [
    "@deepseek-ai/dsh-sandbox-local",
    "koffi",
    "@koromix/koffi-linux-x64",
    "@deepseek-ai/node-addon-landlock-run",
    // Step 16: better-sqlite3 is a real native (N-API) binding, same
    // class of issue as the sandbox natives above -- Turbopack can't
    // bundle it, it has to stay a real require() resolved by Node.
    "better-sqlite3",
  ],
};

export default nextConfig;
