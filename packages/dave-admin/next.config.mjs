/** @type {import('next').NextConfig} */
const nextConfig = {
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
