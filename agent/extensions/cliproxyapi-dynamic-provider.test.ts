import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

// This file lives in an auto-discovered extension directory: normal Pi loads must
// be inert. Only the explicitly authorized node --test runner registers tests.
export default function providerTestExtension() {}

if (process.env.NODE_TEST_CONTEXT) {
// Capture source before evaluating it; nothing imports the extension into the real host.
const source = readFileSync(new URL("./cliproxyapi-dynamic-provider.ts", import.meta.url), "utf8");
const modelId = "Cod/gpt-6.1-sol";
const enriched = { models: [{ slug: modelId, context_window: 300000, max_tokens: 100000,
    supported_reasoning_levels: [{ effort: "medium" }], input_modalities: ["text", "image"] }] };
const response = (payload: unknown, status = 200) => ({
    ok: status === 200, status,
    json: async () => payload,
    text: async () => "untrusted provider response containing a secret",
});

function host(fetchImpl: (...args: any[]) => any, options: { key?: string; source?: string; fastTimeout?: boolean } = {}) {
    const registrations: any[] = [];
    const timeouts: number[] = [];
    const code = stripTypeScriptTypes(options.source ?? source)
        .replace("export default ", "globalThis.factory = ");
    const context = vm.createContext({
        process: { env: { CLIPROXYAPI_API_KEY: options.key ?? "mock-key", CLIPROXYAPI_BASE_URL: "http://mock.invalid/v1/" } },
        fetch: fetchImpl,
        AbortSignal: { timeout(ms: number) {
            timeouts.push(ms);
            return AbortSignal.timeout(options.fastTimeout ? 20 : ms);
        } },
    });
    vm.runInContext(code, context);
    return { factory: () => context.factory({ registerProvider: (id: string, config: any) => registrations.push({ id, config }) }),
        registrations, timeouts };
}

// Verbatim original factory captured before the implementation edit. Helpers stay shared:
// the production diff must not change discovery/normalization/refresh behavior.
const originalFactory = `export default function cliproxyapiDynamicProvider(pi: ExtensionAPI) {
    pi.registerProvider(PROVIDER_ID, {
        name: "CLIProxyAPI",
        baseUrl: \`\${resolveBaseUrl()}/v1\`,
        apiKey: "$CLIPROXYAPI_API_KEY",
        api: "openai-completions",
        compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: true,
            supportsUsageInStreaming: true,
            maxTokensField: "max_tokens",
        },
        async refreshModels({ signal }: { signal?: AbortSignal } = {}) {
            return fetchCLIProxyModels(signal);
        },
    });
}
`;
const originalSource = source.slice(0, source.indexOf("export default ")) + originalFactory;

test("original factory leaves startup catalog empty, but later refresh discovers the exact slug", { timeout: 2000 }, async () => {
    let requests = 0;
    const h = host(async () => { requests++; return response(enriched); }, { source: originalSource });
    await h.factory();
    assert.equal(requests, 0);
    assert.equal(h.registrations[0].config.models, undefined);
    const models = await h.registrations[0].config.refreshModels();
    assert.equal(models[0].id, modelId);
    assert.equal(models[0].thinkingLevelMap.medium, "medium");
    assert.equal(requests, 1);
});

test("factory completion registers normalized catalog before startup selection; refresh stays live", { timeout: 2000 }, async () => {
    const calls: any[] = [];
    const h = host(async (url, init) => { calls.push({ url, init }); return response(enriched); });
    await h.factory();
    const { id, config } = h.registrations[0];
    assert.equal(id, "cliproxyapi");
    assert.equal(config.models?.[0]?.id, modelId, "startup catalog must contain requested model when factory resolves");
    assert.equal(config.models[0].thinkingLevelMap.medium, "medium");
    assert.equal(config.models[0].contextWindow, 272000);
    assert.equal(config.models[0].maxTokens, 65536);
    assert.equal(config.baseUrl, "http://mock.invalid/v1");
    assert.equal(config.apiKey, "$CLIPROXYAPI_API_KEY");
    assert.equal(calls[0].init.headers.Authorization, "Bearer mock-key");
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    assert.ok(h.timeouts[0] > 0 && h.timeouts[0] <= 15000);
    const controller = new AbortController();
    const refreshed = await config.refreshModels({ signal: controller.signal });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].init.signal, controller.signal);
    const old = host(async () => response(enriched), { source: originalSource });
    await old.factory();
    assert.equal(JSON.stringify(refreshed), JSON.stringify(await old.registrations[0].config.refreshModels()));
    assert.equal(JSON.stringify(config.compat), JSON.stringify(old.registrations[0].config.compat));
});

test("factory waits for discovery instead of registering an empty provider early", { timeout: 2000 }, async () => {
    let release!: (value: any) => void;
    const h = host(() => new Promise(resolve => { release = resolve; }));
    const pending = h.factory();
    assert.equal(h.registrations.length, 0);
    release(response(enriched));
    await pending;
    assert.equal(h.registrations[0].config.models[0].id, modelId);
});

test("startup uses standard discovery fallback and unchanged refresh normalization", { timeout: 2000 }, async () => {
    const calls: string[] = [];
    const fallback = { data: [{ id: modelId, context_length: 500000, max_output_tokens: 999999 }] };
    const fetcher = async (url: string) => { calls.push(url); return response(url.includes("?") ? {} : fallback); };
    const h = host(fetcher);
    await h.factory();
    assert.equal(h.registrations[0].config.models?.[0]?.id, modelId);
    assert.deepEqual(calls, ["http://mock.invalid/v1/models?client_version=1", "http://mock.invalid/v1/models"]);
    const old = host(fetcher, { source: originalSource });
    await old.factory();
    assert.equal(JSON.stringify(h.registrations[0].config.models), JSON.stringify(await old.registrations[0].config.refreshModels()));
});

for (const [label, fetcher] of [
    ["HTTP failure", async () => response({}, 503)],
    ["empty catalog", async () => response({ data: [] })],
    ["invalid model IDs", async () => response({ models: [{ slug: " " }] })],
    ["malformed payload", async () => response({ data: {} })],
    ["transport failure", async () => { throw new Error("mock-key and private network detail"); }],
] as const) {
    test(`startup ${label} is explicit and does not register a successful empty provider`, { timeout: 2000 }, async () => {
        const h = host(fetcher);
        await assert.rejects(async () => h.factory(), (error: any) => {
            assert.match(error.message, /CLIProxyAPI.*startup.*(failed|empty)/i);
            assert.doesNotMatch(error.message, /mock-key|private network|untrusted provider/);
            return true;
        });
        assert.equal(h.registrations.length, 0);
    });
}

test("missing authentication does not fetch or register", { timeout: 2000 }, async () => {
    const h = host(() => { assert.fail("must not fetch without a key"); }, { key: "" });
    await assert.rejects(async () => h.factory(), /CLIPROXYAPI_API_KEY/);
    assert.equal(h.registrations.length, 0);
});

test("startup timeout cancels stalled discovery within one shared bounded deadline", { timeout: 2000 }, async () => {
    const signals: AbortSignal[] = [];
    const h = host((_url, { signal }) => {
        signals.push(signal);
        return new Promise((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
    }, { fastTimeout: true });
    // AbortSignal.timeout is unref'ed; keep this isolated test alive until its deadline.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
        await assert.rejects(async () => h.factory(), /CLIProxyAPI.*startup.*failed/i);
        assert.ok(signals.length >= 1 && signals.length <= 2);
        assert.ok(signals.every(signal => signal === signals[0] && signal.aborted));
        assert.equal(h.timeouts.length, 1);
        assert.equal(h.registrations.length, 0);
    } finally {
        clearTimeout(keepAlive);
    }
});
}
