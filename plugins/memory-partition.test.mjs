import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const source = await readFile(new URL("./memory-partition.js", import.meta.url), "utf8");
const plugin = (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default;
const values = new Map();
// 模拟 IndexedDB 事务完成/失败，测试插件只在持久化成功后允许发送。
let failWrite = false;
globalThis.indexedDB = {
  open() {
    const request = {};
    queueMicrotask(() => {
      request.result = {
        close() {},
        transaction() {
          const tx = { objectStore: () => ({
            get(key) {
              const result = { result: values.get(key) };
              queueMicrotask(() => tx.oncomplete());
              return result;
            },
            put(value, key) {
              queueMicrotask(() => {
                if (failWrite) tx.onabort();
                else { values.set(key, value); tx.oncomplete(); }
              });
              return {};
            },
          }) };
          return tx;
        },
      };
      request.onsuccess();
    });
    return request;
  },
};
const now = Date.parse("2026-09-24T12:00:00Z");
const record = (id, hours, content = "约好周五一起吃饭") => ({ id, timestamp: new Date(now - hours * 3600000).toISOString(), content });
function harness(settings = {}, respond = async () => "用户与角色约好周五一起吃饭。") {
  let handler, calls = 0;
  const ctx = {
    meta: { contextPartitionVersion: 1 },
    hooks: { transform(point, fn) { assert.equal(point, "context.prepare"); handler = fn; } },
    system: { settings: { get: key => settings[key] } }, ui: { toast() {} },
    ai: { chat: async args => { calls++; return respond(args); } },
  };
  const cleanup = plugin.setup(ctx);
  return {
    run: (records, overrides = {}) => handler({ sessionId: "测试", mode: "online", now, query: "周五约定", records, ...overrides }),
    get calls() { return calls; }, cleanup,
  };
}
test("默认 24 小时边界及摘要复用", async () => {
  values.clear();
  const h = harness();
  const records = [record("old", 25), record("boundary", 24), record("new", 1)];
  const first = await h.run(records);
  assert.equal(first.partition.state, "ready");
  assert.equal(first.partition.cutoff, now - 24 * 3600000);
  assert.match(first.partition.memory, /周五/);
  assert.equal(h.calls, 1);
  await h.run(records);
  assert.equal(h.calls, 1);
  h.cleanup();
});
test("手动时长、无旧记录及错误设置", async () => {
  const h = harness({ windowHours: 48 });
  assert.equal((await h.run([record("old", 25)])).partition.memory, "");
  assert.equal(h.calls, 0);
  assert.equal((await harness({ windowHours: 0 }).run([])).partition.state, "error");
  assert.equal((await harness().run([{ id: "bad", timestamp: "", content: "" }])).partition.state, "error");
});
test("在线、线下、不同会话隔离，编辑后重新总结，删除后不注入", async () => {
  values.clear();
  const h = harness();
  await h.run([record("old", 25)]);
  await h.run([record("old", 25)], { mode: "offline" });
  await h.run([record("old", 25)], { sessionId: "另一会话" });
  await h.run([record("old", 25, "约定已取消")]);
  assert.equal(h.calls, 4);
  assert.equal((await h.run([])).partition.memory, "");
});
test("总结失败或存储失败时禁止裁剪", async () => {
  values.clear();
  const failed = harness({}, async () => { throw new Error("网络失败"); });
  assert.equal((await failed.run([record("old", 25)])).partition.state, "error");
  failWrite = true;
  try { assert.equal((await harness().run([record("old", 25)])).partition.state, "error"); }
  finally { failWrite = false; }
  assert.equal(values.size, 0);
});
test("长历史分批、可恢复进度、摘要预算", async () => {
  values.clear();
  const h = harness();
  const records = Array.from({ length: 6 }, (_, i) => record(`${i}`, 30 - i, "历史".repeat(4500)));
  assert.equal((await h.run(records)).partition.state, "error");
  assert.equal(h.calls, 4);
  const completed = await h.run(records);
  assert.equal(completed.partition.state, "ready");
  assert.equal(h.calls, 6);
  assert.ok(completed.partition.memory.length <= 6000);
});
test("不兼容宿主明确拒绝启用", () => {
  assert.throws(() => plugin.setup({ meta: {} }), /配套宿主补丁/);
});

// 使用 Node 自带 TypeScript 去类型工具执行真实宿主筛选函数，不安装依赖。
const helperSource = await readFile(new URL("../lib/chat-context-partition.ts", import.meta.url), "utf8");
const helperJs = stripTypeScriptTypes(helperSource).replace(/^import .*;\r?\n/gm, "");
const host = { enabled: true, transform: async (_point, payload) => payload, timeline: [] };
globalThis.__partitionTest = host;
globalThis.window = {};
const mocks = `
const getChatPluginHookBus = () => ({hasHandlers: () => globalThis.__partitionTest.enabled});
const runChatPluginTransform = (...args) => globalThis.__partitionTest.transform(...args);
const loadNativeTimeline = () => globalThis.__partitionTest.timeline;
const filterTimelineByAllowedSources = entries => entries;
const loadMemoryConfig = () => ({});
`;
const { partitionChatHistory, prepareChatContextPartition } = await import(`data:text/javascript;base64,${Buffer.from(mocks + helperJs).toString("base64")}`);
test("宿主过滤原文不改源数据，工具跨边界时明确报错", () => {
  const history = [25, 24, 1].map((hours, i) => ({ id: `${i}`, createdAt: record("", hours).timestamp }));
  assert.deepEqual(partitionChatHistory(history, now - 24 * 3600000).map(item => item.id), ["1", "2"]);
  assert.equal(history.length, 3);
  assert.throws(() => partitionChatHistory([{ createdAt: new Date(now).toISOString(), nativeToolResult: { toolCallId: "old" } }], now - 1000), /工具调用/);
});
test("宿主 pending、错误及非法边界不允许发出聊天", async () => {
  const session = { id: "测试" };
  for (const partition of [
    { state: "pending", cutoff: now, memory: "" },
    { state: "error", cutoff: now, memory: "", error: "总结失败" },
    { state: "ready", cutoff: NaN, memory: "" },
    { state: "ready", cutoff: Date.now() + 1000000, memory: "" },
  ]) {
    host.transform = async (_point, payload) => ({ ...payload, partition });
    await assert.rejects(() => prepareChatContextPartition(session, [], [], false));
  }
  host.enabled = false;
  assert.equal(await prepareChatContextPartition(session, [], [], false), undefined);
  host.enabled = true;
});
test("宿主给插件提供线下原文和跨功能聊天素材", async () => {
  host.timeline = [
    { id: "online", sourceApp: "chat", timestamp: new Date(now).toISOString(), content: "线上约定" },
    { id: "offline", sourceApp: "story", sourceDetail: "chat_offline", timestamp: new Date(now).toISOString(), content: "线下约定" },
    { id: "story", sourceApp: "story", sourceDetail: "story", timestamp: new Date(now).toISOString(), content: "独立故事" },
  ];
  host.transform = async (_point, payload) => {
    assert.equal(payload.mode, "offline");
    assert.equal(payload.records.length, 3);
    assert.ok(payload.records.some(record => record.content === "assistant: 线下原文"));
    return { ...payload, partition: { state: "ready", cutoff: now, memory: "已保存的摘要" } };
  };
  const result = await prepareChatContextPartition({ id: "测试" }, [{ id: "turn", role: "assistant", content: "线下原文", createdAt: new Date(now).toISOString() }], ["角色"], true);
  assert.equal(result.memory, "已保存的摘要");
});
