import { VibeGuardPrivacy } from "./v1.js"
import { setupV2 } from "./v2.js"

// 单包双支持（官方推荐形态）：V1 调用 `server(ctx)`，V2 调用 `setup(ctx)`。
// `Plugin.define` 是透传函数，这里不静态依赖 `@opencode/plugin`，
// V1 环境（没有该包）也能正常加载。V1 逻辑在 `src/v1.js`（原 `src/index.js`，未改动）。
export default {
  id: "opencode-vibeguard",
  setup: setupV2,
  server: VibeGuardPrivacy,
}
