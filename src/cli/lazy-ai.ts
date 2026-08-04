// The value side of the AI layer is loaded lazily. `../ai/index.js` statically pulls
// in the Anthropic and OpenAI SDKs (+31 ms and +15 MB RSS), which every invocation
// paid — including `--help` and every run without `--explain`. Measured: `--help`
// 62.7 -> 35.2 ms, `analyze <small xml>` 72.4 -> 45.5 ms. Import the *types* from
// `../ai/index.js` directly with `import type`; only the runtime side goes through here.
export const loadAi = () => import("../ai/index.js");
