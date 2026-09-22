// 包根入口：opencode v2 的本地目录加载只认目录顶层的 index.js，
// 不解析 package.json 的 main。保持单包双支持，实际逻辑在 src/。
export { default } from "./src/index.js"
