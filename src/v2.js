import { loadConfig } from "./config.js"
import { buildPatternSet } from "./patterns.js"
import { PlaceholderSession } from "./session.js"
import { redactText } from "./engine.js"
import { redactDeep, restoreDeep } from "./deep.js"

/**
 * V2 setup (`Plugin.define({ id, setup })` 形态，`Plugin.define` 是透传，
 * 所以这里直接返回 `{ id, setup }` 所需的 setup 函数，不依赖 `@opencode/plugin`)。
 *
 * 映射关系（见迁移指南）：
 * - V1 `experimental.chat.messages.transform` -> `ctx.session.hook("context" | "compaction" | "generate" | "title")`，改 `event.messages / event.system`
 * - V1 `chat.message`（用户原文） -> `ctx.session.hook("prompt")`，改 `event.prompt.text`（落库即占位符）
 * - V1 `tool.execute.before` -> `ctx.tool.hook("execute.before")`，还原占位符保证本地执行拿到真值
 * - V1 `tool.execute.after`（新增，原来没有）-> `ctx.tool.hook("execute.after")`，工具输出重新脱敏，避免明文落库
 *
 * 说明：
 * - `reasoning.encrypted` / `compaction.encrypted` 是 provider 签名，原样透传，绝不改写。
 * - V1 的 `experimental.text.complete`（输出还原展示）在 V2 没有对应钩子；这里刻意不还原
 *   持久化内容，DB 里保持占位符更安全。工具执行前由 `execute.before` 还原，不影响功能。
 */
export async function setupV2(ctx) {
  const directory = ctx?.location?.directory ?? process.cwd()
  const config = await loadConfig(directory)
  const debug = Boolean(process.env.OPENCODE_VIBEGUARD_DEBUG) || Boolean(config.debug)

  if (debug) {
    const from = config.loadedFrom ? config.loadedFrom : "未找到（插件将 no-op）"
    console.log(`[opencode-vibeguard] 配置：${from} enabled=${config.enabled}`)
  }

  if (!config.enabled) return

  const patterns = buildPatternSet(config.patterns)
  const sessions = new Map()

  const getSession = (sessionID) => {
    const key = String(sessionID ?? "")
    if (!key) return null
    const existing = sessions.get(key)
    if (existing) return existing
    const created = new PlaceholderSession({
      prefix: config.prefix,
      ttlMs: config.ttlMs,
      maxMappings: config.maxMappings,
    })
    sessions.set(key, created)
    return created
  }

  const redactString = (value, session) => {
    if (typeof value !== "string" || !value) return value
    return redactText(value, patterns, session).text
  }

  // tool-result 的 result 是 { type, value } 联合体：text/error 的 string value 直接脱敏，
  // json / 对象型 value 走深度脱敏，content 型数组逐条脱敏 text 条目。
  const redactResultValue = (result, session) => {
    if (!result || typeof result !== "object") return
    const { type, value } = result
    if (type === "content" && Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && item.type === "text" && typeof item.text === "string") {
          item.text = redactString(item.text, session)
        }
      }
      return
    }
    if (typeof value === "string") {
      result.value = redactString(value, session)
      return
    }
    if (value && typeof value === "object") redactDeep(value, patterns, session)
  }

  // V2 Message.content: text | reasoning | tool-call | tool-result | compaction | effort | media
  const redactContent = (content, session) => {
    if (!Array.isArray(content)) return
    for (const part of content) {
      if (!part || typeof part !== "object") continue
      if (part.type === "text" && typeof part.text === "string") {
        part.text = redactString(part.text, session)
      } else if (part.type === "reasoning" && typeof part.text === "string") {
        part.text = redactString(part.text, session)
        // part.encrypted 是 provider 签名，保持原样
      } else if (part.type === "tool-call" && part.input && typeof part.input === "object") {
        redactDeep(part.input, patterns, session)
      } else if (part.type === "tool-result" && part.result && typeof part.result === "object") {
        redactResultValue(part.result, session)
      } else if (part.type === "compaction" && typeof part.text === "string") {
        part.text = redactString(part.text, session)
      }
    }
  }

  const redactRequest = (event) => {
    const session = getSession(event?.sessionID)
    if (!session) return
    session.cleanup()
    if (Array.isArray(event.system)) {
      for (const part of event.system) {
        if (part && typeof part === "object" && typeof part.text === "string") {
          part.text = redactString(part.text, session)
        }
      }
    }
    if (Array.isArray(event.messages)) {
      for (const msg of event.messages) {
        if (msg && typeof msg === "object") redactContent(msg.content, session)
      }
    }
  }

  // prompt 在入库前脱敏：DB 里存占位符，provider 永远见不到真值。
  // 改写 text 会让 files/agents/skills 的 mention 偏移失效，直接清除。
  await ctx.session.hook("prompt", (event) => {
    const session = getSession(event?.sessionID)
    if (!session) return
    session.cleanup()
    if (typeof event.prompt?.text === "string") {
      const before = event.prompt.text
      const after = redactString(before, session)
      if (after !== before) {
        event.prompt.text = after
        for (const f of event.prompt.files ?? []) {
          if (f && typeof f === "object" && "mention" in f) f.mention = undefined
        }
        for (const a of event.prompt.agents ?? []) {
          if (a && typeof a === "object" && "mention" in a) a.mention = undefined
        }
        for (const s of event.prompt.skills ?? []) {
          if (s && typeof s === "object" && "mention" in s) s.mention = undefined
        }
      }
    }
  })

  // 发往模型前的各路请求统一脱敏（只影响本次出站，不改持久化历史）。
  await ctx.session.hook("context", redactRequest)
  await ctx.session.hook("compaction", redactRequest)
  await ctx.session.hook("generate", redactRequest)
  await ctx.session.hook("title", redactRequest)

  // 工具执行前还原占位符：本地执行拿到真值。
  await ctx.tool.hook("execute.before", (event) => {
    const session = getSession(event?.sessionID)
    if (!session) return
    session.cleanup()
    restoreDeep(event.input, session)
  })

  // 工具执行后重新脱敏：输出入库前变回占位符，避免明文落库。
  await ctx.tool.hook("execute.after", (event) => {
    const session = getSession(event?.sessionID)
    if (!session) return
    session.cleanup()
    if (event.status === "completed" && event.result && typeof event.result === "object") {
      const { output, content, metadata } = event.result
      if (output && typeof output === "object") redactDeep(output, patterns, session)
      else if (typeof output === "string") event.result.output = redactString(output, session)
      if (typeof content === "string") event.result.content = redactString(content, session)
      else if (Array.isArray(content)) {
        for (const item of content) {
          if (item && typeof item === "object" && item.type === "text" && typeof item.text === "string") {
            item.text = redactString(item.text, session)
          }
        }
      }
      if (metadata && typeof metadata === "object") redactDeep(metadata, patterns, session)
    } else if (event.status === "error" && event.error) {
      if (typeof event.error.message === "string") {
        event.error.message = redactString(event.error.message, session)
      }
      if (event.error.metadata && typeof event.error.metadata === "object") {
        redactDeep(event.error.metadata, patterns, session)
      }
    }
  })

  if (debug) console.log("[opencode-vibeguard] v2 hooks 已注册：prompt/context/compaction/generate/title + tool execute.before/after")
}
