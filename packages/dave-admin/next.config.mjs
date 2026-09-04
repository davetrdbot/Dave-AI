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
  ],
};

export default nextConfig;
