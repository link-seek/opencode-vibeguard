import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { buildPatternSet } from "../src/patterns.js"
import { PlaceholderSession } from "../src/session.js"
import { redactText } from "../src/engine.js"
import {
  normalizeSubscription,
  fetchRulesDoc,
  mergePatterns,
  createSubscription,
} from "../src/subscription.js"

const LOCAL_SECRET = "cfut_" + "A".repeat(30)
const REMOTE_SECRET = "sk_test_" + "B".repeat(24)

function remoteDoc() {
  return {
    version: 7,
    updated: "2026-09-23",
    patterns: {
      keywords: [],
      regex: [{ pattern: "sk_test_[A-Za-z0-9]+", category: "REMOTE_KEY" }],
      builtin: [],
      exclude: [],
    },
  }
}

let server = null
let base = ""
const routes = new Map()

before(
  () =>
    new Promise((resolve) => {
      server = http.createServer((req, res) => {
        const h = routes.get(req.url)
        if (!h) {
          res.writeHead(404).end()
          return
        }
        h(req, res)
      })
      server.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${server.address().port}`
        routes.set("/good.json", (_req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(remoteDoc()))
        })
        routes.set("/bad-shape.json", (_req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" }).end('{"nope":true}')
        })
        routes.set("/bad-regex.json", (_req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              version: 1,
              patterns: { regex: [{ pattern: "([invalid", category: "X" }] },
            }),
          )
        })
        routes.set("/500.json", (_req, res) => {
          res.writeHead(500).end("boom")
        })
        routes.set("/slow.json", (_req, res) => {
          setTimeout(() => res.writeHead(200).end("{}"), 3000)
        })
        resolve()
      })
    }),
)

after(() => new Promise((resolve) => server.close(resolve)))

function memStorage() {
  const m = new Map()
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => void m.set(k, v),
  }
}

function localPatterns() {
  return {
    regex: [{ pattern: "\\bcfut_[A-Za-z0-9_-]{30,}\\b", category: "CLOUDFLARE_USER_TOKEN" }],
    builtin: [],
    keywords: [],
    exclude: [],
  }
}

function redactAll(set, text) {
  const session = new PlaceholderSession({ prefix: "__VG_", ttlMs: 3600000, maxMappings: 1000 })
  return redactText(text, set, session).text
}

describe("rules subscription", () => {
  it("normalize defaults to enabled with sane refresh/timeout", () => {
    const s = normalizeSubscription(undefined)
    assert.equal(s.enabled, true)
    assert.ok(s.url.includes("rules.json"))
    assert.equal(s.refreshMs, 24 * 3600000)
  })

  it("fetch + merge: remote rules supplement local, local wins on conflict", async () => {
    const doc = await fetchRulesDoc(`${base}/good.json`, 5000)
    assert.equal(doc.version, 7)
    const merged = mergePatterns(localPatterns(), doc.patterns)
    const set = buildPatternSet(merged)
    assert.doesNotMatch(redactAll(set, `a ${LOCAL_SECRET} b`), /cfut_/)
    assert.doesNotMatch(redactAll(set, `a ${REMOTE_SECRET} b`), /sk_test_/)
  })

  it("invalid shape / bad regex / http error are rejected", async () => {
    await assert.rejects(fetchRulesDoc(`${base}/bad-shape.json`, 5000))
    await assert.rejects(fetchRulesDoc(`${base}/500.json`, 5000))
    // 坏正则被清洗掉，不抛错但结果为空规则
    const doc = await fetchRulesDoc(`${base}/bad-regex.json`, 5000)
    assert.equal(doc.patterns.regex.length, 0)
  })

  it("timeout aborts slow responses", async () => {
    await assert.rejects(fetchRulesDoc(`${base}/slow.json`, 200))
  })

  it("subscription start applies remote rules and caches; failure is fail-closed", async () => {
    const storage = memStorage()
    const sub = normalizeSubscription({ url: `${base}/good.json`, refresh: "1h", timeoutMs: 5000 })
    const s = createSubscription({
      sub,
      localPatterns: localPatterns(),
      buildPatternSet,
      storage,
      debug: false,
      log: () => {},
    })
    await s.start()
    try {
      assert.doesNotMatch(redactAll(s.ref.current, REMOTE_SECRET), /sk_test_/)
      const cached = await storage.get("vibeguard:rules-doc")
      assert.equal(cached.doc.version, 7)

      // 远端挂了：刷新失败，现有规则（含远端）保持
      const sub2 = normalizeSubscription({ url: `${base}/500.json`, refresh: "1h", timeoutMs: 5000 })
      const s2 = createSubscription({
        sub: sub2,
        localPatterns: localPatterns(),
        buildPatternSet,
        storage: memStorage(),
        debug: false,
        log: () => {},
      })
      await s2.start()
      try {
        assert.doesNotMatch(redactAll(s2.ref.current, LOCAL_SECRET), /cfut_/)
        assert.match(redactAll(s2.ref.current, REMOTE_SECRET), /sk_test_/)
      } finally {
        s2.stop()
      }
    } finally {
      s.stop()
    }
  })

  it("cold start uses cache without network", async () => {
    const storage = memStorage()
    await storage.set("vibeguard:rules-doc", {
      fetchedAt: Date.now(),
      url: `${base}/unreachable.json`,
      doc: remoteDoc(),
    })
    const sub = normalizeSubscription({ url: `${base}/unreachable.json`, refresh: "0", timeoutMs: 500 })
    const s = createSubscription({
      sub,
      localPatterns: localPatterns(),
      buildPatternSet,
      storage,
      debug: false,
      log: () => {},
    })
    // refresh 0 -> parseRefreshMs 拒绝 0，回落 24h；关掉定时器避免悬挂
    await s.start()
    s.stop()
    assert.doesNotMatch(redactAll(s.ref.current, REMOTE_SECRET), /sk_test_/)
  })
})
