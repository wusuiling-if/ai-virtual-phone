import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// weixin-cloud-sync 是 TS 且依赖浏览器侧模块，注册一个即时转译 + 桩件的加载器跑起来。
const hooks = `
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import ts from ${JSON.stringify(pathToFileURL(path.join(root, "node_modules/typescript/lib/typescript.js")).href)};

const ROOT = ${JSON.stringify(root)};
const EXTS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx", ".mjs", ".js"];
// Dexie 是 CJS，ESM 具名导入拿不到 default；这里只需要它能被 import 而已。
const STUBS = { dexie: "export default class Dexie { version(){return{stores(){return{upgrade(){}}}}} table(){return{}} open(){return Promise.resolve()} }" };

export async function resolve(specifier, context, next) {
  if (STUBS[specifier]) {
    return { url: "data:text/javascript;base64," + Buffer.from(STUBS[specifier]).toString("base64"), shortCircuit: true, format: "module" };
  }
  let spec = specifier;
  if (spec.startsWith("@/")) spec = pathToFileURL(resolvePath(ROOT, spec.slice(2))).href;
  else if (spec.startsWith(".") && context.parentURL?.startsWith("file:")) {
    spec = pathToFileURL(resolvePath(dirname(fileURLToPath(context.parentURL)), spec)).href;
  } else return next(specifier, context);
  for (const ext of EXTS) {
    try { readFileSync(fileURLToPath(spec + ext)); return { url: spec + ext, shortCircuit: true, format: "module" }; } catch {}
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (!url.endsWith(".ts") && !url.endsWith(".tsx")) return next(url, context);
  const out = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve },
    fileName: fileURLToPath(url),
  }).outputText;
  return { format: "module", shortCircuit: true, source: out };
}
`;
register("data:text/javascript;base64," + Buffer.from(hooks).toString("base64"), pathToFileURL(root + "/"));

const assert = (await import('node:assert/strict')).default;
const { parseCharacterFromJson, parseCharacterFromPng } = await import('../lib/character-storage.ts');
const { parseWorldBookFromJson, parseWorldBookEntry } = await import('../lib/settings-storage.ts');
const { isWorldBookEntryActivated, assemblePromptPayload } = await import('../lib/llm-prompt-assembler.ts');
const { buildProviderRequest, parseProviderResponse, parseProviderStreamDelta } = await import('../lib/llm-provider-adapter.ts');
const { buildRequestHeaders, determineBaseUrl, simpleLLMCall } = await import('../lib/api-helpers.ts');
const { decodeMinimaxAudio, minimaxSpeechUrl } = await import('../lib/minimax-audio.ts');
const { synthesizeSpeech } = await import('../lib/tts-service.ts');
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`✓ ${name}`); }

await test('V2/V3 角色卡保留背景、示例、原始开场白和内嵌世界书', () => {
    for (const spec of ['chara_card_v2', 'chara_card_v3']) {
        const card = { spec, data: { name: '小雨', description: '人设', personality: '友善', scenario: '书店', first_mes: '你好', mes_example: '示例', character_book: { entries: [] }, extensions: { untouched: true } } };
        const result = parseCharacterFromJson(JSON.stringify(card));
        assert.equal(result.name, '小雨'); assert.match(result.persona, /书店/); assert.match(result.persona, /示例/);
        assert.deepEqual(result.importedCard, card);
    }
    assert.equal(parseCharacterFromJson('null'), null);
    assert.equal(parseCharacterFromJson('{}'), null);
});
await test('原生角色卡往返不会重复拼接酒馆背景', () => {
    const c = parseCharacterFromJson(JSON.stringify({ name: 'A', persona: '背景', importedCard: { spec: 'chara_card_v2' }, schema: 'ai_phone_character' }));
    assert.equal(c.persona, '背景'); assert.equal(c.importedCard.spec, 'chara_card_v2');
});
await test('PNG chara/ccv3 数据读取与截断校验', () => {
    for (const keyword of ['chara', 'ccv3', 'ai_phone_character']) {
        const data = Buffer.from(keyword + '\0' + Buffer.from(JSON.stringify({ name: '雨', description: '中文' })).toString('base64'));
        const png = Buffer.alloc(8 + 12 + data.length);
        Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(data.length, 8); png.write('tEXt', 12); data.copy(png, 16);
        assert.equal(parseCharacterFromPng(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)).name, '雨');
        assert.equal(parseCharacterFromPng(png.buffer.slice(png.byteOffset, png.byteOffset + 20)), null);
    }
});
await test('字典世界书保留 ID、零概率和正则中的逗号', () => {
    const b = parseWorldBookFromJson(JSON.stringify({ entries: { '0': { key: ['/a,b/i'], content: '背景', probability: 0, useProbability: true }, '2': { keys: ['foo'], secondary_keys: ['bar'], extensions: { selectiveLogic: 3 } } } }));
    assert.equal(b.entries[0].uid, '0'); assert.equal(b.entries[0].probability, 0);
    assert.deepEqual(b.entries[0].keys, ['/a,b/i']); assert.equal(b.entries[1].selectiveLogic, 3);
    assert.equal(parseWorldBookFromJson('{}'), null);
});
await test('常驻条目也遵守 0% 概率；关键词和次关键词逻辑有效', () => {
    assert.equal(isWorldBookEntryActivated(parseWorldBookEntry({ constant: true, probability: 0, useProbability: true }), ''), false);
    const e = parseWorldBookEntry({ key: ['/a,b/i'], keysecondary: ['yes', 'ok'], selectiveLogic: 3 });
    assert.equal(isWorldBookEntryActivated(e, 'A,B yes ok'), true);
    assert.equal(isWorldBookEntryActivated(e, 'A,B yes'), false);
    assert.equal(isWorldBookEntryActivated({ ...e, selectiveLogic: 2 }, 'A,B'), true);
    assert.equal(isWorldBookEntryActivated({ ...e, selectiveLogic: 2 }, 'A,B yes'), false);
    assert.equal(isWorldBookEntryActivated(parseWorldBookEntry({ key: ['cat'], matchWholeWords: true }), 'concatenate'), false);
    assert.equal(isWorldBookEntryActivated(parseWorldBookEntry({ key: ['cat'], matchWholeWords: true }), 'a cat!'), true);
});
const base = { id: 'api', provider: 'Custom', baseUrl: 'https://relay.example/v1', apiKey: ' key ', defaultModel: 'some-model', enableImageRecognition: false, enableImageGeneration: false };
const messages = [{ role: 'user', content: '你好' }];
await test('原生小手机请求不因兼容设置缺省而改变协议', () => {
    const r = buildProviderRequest(base, null, messages);
    assert.equal(r.providerKind, 'openai-compatible'); assert.equal(r.url, 'https://relay.example/v1/chat/completions');
    assert.deepEqual(r.body.messages, messages);
    assert.equal(buildProviderRequest({ ...base, provider: 'Anthropic' }, null, messages).providerKind, 'openai-compatible');
});
await test('原生 Claude 中转、无 Key 本地服务及自定义请求头', () => {
    const r = buildProviderRequest({ ...base, protocol: 'anthropic', customHeaders: { 'x-test': 'ok' }, serverProxy: true }, null, messages);
    assert.equal(r.url, 'https://relay.example/v1/messages'); assert.equal(r.headers['x-api-key'], 'key');
    assert.equal(r.headers['x-test'], 'ok'); assert.equal(r.serverProxy, true);
    const local = buildProviderRequest({ ...base, provider: 'Ollama', baseUrl: '', apiKey: '', authMode: 'none' }, null, messages);
    assert.equal(local.url, 'http://localhost:11434/v1/chat/completions'); assert.equal(local.headers.Authorization, undefined);
    assert.throws(() => buildProviderRequest({ ...base, apiKey: '' }, null, messages), /API Key/);
});
await test('MiniMax 地址归一化、业务错误、无效音频和 hex 解码', async () => {
    assert.equal(minimaxSpeechUrl('https://api.minimax.io'), 'https://api.minimax.io/v1/t2a_v2');
    assert.equal(minimaxSpeechUrl('https://api.minimax.io/v1/t2a_v2?GroupId=123'), 'https://api.minimax.io/v1/t2a_v2?GroupId=123');
    assert.throws(() => decodeMinimaxAudio({ base_resp: { status_code: 1004, status_msg: 'invalid key' }, data: { audio: 'ffee' } }), /1004/);
    assert.throws(() => decodeMinimaxAudio({ data: { audio: 'https://example.com/audio' } }), /hex/);
    assert.deepEqual([...new Uint8Array(await decodeMinimaxAudio({ data: { audio: '494433ff' } }).arrayBuffer())], [73,68,51,255]);
});
await test('MiniMax 官方请求经服务端且显式请求 hex；自定义直连不会重复路径', async () => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ base_resp: { status_code: 0 }, data: { audio: '494433ff' } }); };
    try {
        const v = { id: 'v', provider: 'Minimax', apiKey: 'test', defaultVoice: 'voice', model: 'speech-2.8-hd' };
        const blob = await synthesizeSpeech('test', v); assert.equal(blob.size, 4);
        assert.equal(calls[0].url, '/api/model-request');
        const envelope = JSON.parse(calls[0].init.body);
        assert.equal(envelope.url, 'https://api.minimaxi.com/v1/t2a_v2');
        assert.equal(JSON.parse(envelope.body).output_format, 'hex');
        await synthesizeSpeech('test', { ...v, baseUrl: 'https://relay.example/v1/t2a_v2', transport: 'direct' });
        assert.equal(calls[1].url, 'https://relay.example/v1/t2a_v2');
    } finally { globalThis.fetch = original; }
});
await test('模型转发拒绝非授权地址和跨站请求，并保留流式响应', async () => {
    const { POST } = await import('../app/api/model-request/route.ts');
    const req = (input, origin = 'https://phone.example') => new Request('https://phone.example/api/model-request', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(input) });
    assert.equal((await POST(req({ url: 'http://127.0.0.1/private', method: 'GET' }))).status, 400);
    assert.equal((await POST(req({ url: 'https://untrusted.example/v1', method: 'GET' }))).status, 400);
    assert.equal((await POST(req({ url: 'https://api.minimax.io/v1', method: 'POST' }, 'https://other.example'))).status, 403);
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        assert.equal(init.redirect, 'error');
        assert.equal(init.headers.has('cookie'), false);
        assert.equal(init.headers.get('authorization'), 'Bearer test');
        return new Response('data: {"ok":true}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    try {
        const response = await POST(req({ url: 'https://api.openai.com/v1/chat/completions', method: 'POST', headers: { cookie: 'private', authorization: 'Bearer test' }, body: '{}' }));
        assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /event-stream/);
        assert.equal(await response.text(), 'data: {"ok":true}\n\n');
    } finally { globalThis.fetch = original; }
});
const { generateKeyPairSync, verify } = await import('node:crypto');
const { sendVertexRequest, vertexAccessToken } = await import('../lib/vertex-server.ts');
const { fetchLlmPayload } = await import('../lib/llm-http.ts');
const { shouldFallbackToNonStreaming } = await import('../lib/model-stream-fallback.ts');
await test('流式限流、鉴权和网关失败不立即重复生成；协议不兼容仍可降级', () => {
    for (const status of [401, 403, 408, 429, 500, 502, 503, 504]) {
        for (const prefix of ['API', 'API Stream', 'API Tool Stream Error']) {
            assert.equal(shouldFallbackToNonStreaming(new Error(`${prefix} ${status}: failure`)), false);
        }
    }
    assert.equal(shouldFallbackToNonStreaming(new DOMException('cancelled', 'AbortError')), false);
    assert.equal(shouldFallbackToNonStreaming(new Error('Tool Stream Network Error connecting to AI Provider: 模型保活连接提前中断')), false);
    assert.equal(shouldFallbackToNonStreaming(new Error('API Key 为空：provider=OpenAI')), false);
    assert.equal(shouldFallbackToNonStreaming(new Error('API Stream 400: streaming unsupported')), true);
    assert.equal(shouldFallbackToNonStreaming(new Error('API Stream 501: not implemented')), true);
});
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = { type: 'service_account', project_id: 'test-project', client_email: 'test@test-project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://untrusted.invalid/token' };
const vertexConfig = { id: 'test-vertex', provider: 'VertexAI', protocol: 'vertex', apiKey: '', defaultModel: 'gemini-test', enableImageRecognition: true, enableImageGeneration: false, vertexServiceAccount: JSON.stringify(serviceAccount) };
await test('Vertex 完整模式快照无私钥；传输阶段注入凭据；Gemini 系统消息、工具、流式协议复用', async () => {
    const request = buildProviderRequest(vertexConfig, null, [{ role: 'system', content: 'phone system' }, { role: 'user', content: 'hello' }], { stream: true, tools: [{ name: 'phone', description: 'test', parameters: { type: 'object', properties: {} } }] });
    assert.equal(request.providerKind, 'gemini'); assert.match(request.url, /stream=true/);
    assert.equal(request.body.systemInstruction.parts[0].text, 'phone system');
    assert.equal(request.body.tools[0].functionDeclarations[0].name, 'phone');
    assert.ok(!JSON.stringify(request).includes('PRIVATE KEY')); assert.ok(!JSON.stringify(request).includes('client_email'));
    const saved = globalThis.fetch;
    try {
        globalThis.fetch = async (url, init) => {
            assert.ok(String(url).startsWith('/api/vertex?'));
            const envelope = JSON.parse(init.body);
            assert.equal(envelope.serviceAccount.client_email, serviceAccount.client_email);
            assert.equal(envelope.serviceAccount.token_uri, undefined);
            assert.ok(envelope.request.contents.length);
            return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
        };
        await fetchLlmPayload(request);
        const result = await simpleLLMCall(vertexConfig, [{ role: 'system', content: 'phone system' }, { role: 'user', content: 'hi' }]);
        assert.equal(result.content, 'ok');
    } finally { globalThis.fetch = saved; }
});
await test('Vertex RS256 签名、固定 OAuth 目标、令牌缓存及区域流式地址', async () => {
    let oauthCalls = 0;
    const fetcher = async (url, init) => {
        if (url === 'https://oauth2.googleapis.com/token') {
            oauthCalls++;
            const jwt = init.body.get('assertion'); const [header, payload, signature] = jwt.split('.');
            assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
            const claims = JSON.parse(Buffer.from(payload, 'base64url'));
            assert.equal(claims.aud, url); assert.equal(claims.iss, serviceAccount.client_email);
            assert.equal(claims.exp - claims.iat, 3600);
            assert.ok(verify('RSA-SHA256', Buffer.from(header + '.' + payload), publicKey, Buffer.from(signature, 'base64url')));
            return Response.json({ access_token: 'fake-token', expires_in: 3600 });
        }
        assert.equal(url, 'https://us-central1-aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/publishers/google/models/gemini-test:streamGenerateContent?alt=sse');
        assert.equal(init.headers.Authorization, 'Bearer fake-token');
        assert.equal(init.redirect, 'error');
        return new Response('data: {"candidates":[]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const query = new URLSearchParams({ mode: 'full', project: 'test-project', location: 'us-central1', model: 'gemini-test', stream: 'true' });
    for (let i = 0; i < 2; i++) {
        const res = await sendVertexRequest(query, { serviceAccount, request: { contents: [] } }, new AbortController().signal, fetcher);
        assert.equal(res.headers.get('content-type'), 'text/event-stream'); assert.match(await res.text(), /candidates/);
    }
    assert.equal(oauthCalls, 1);
    const savedNow = Date.now;
    try { Date.now = () => savedNow() + 3600000; await vertexAccessToken(serviceAccount, new AbortController().signal, fetcher); }
    finally { Date.now = savedNow; }
    assert.equal(oauthCalls, 2);
});
await test('Vertex 全局地址、Express Key、参数拦截和失败信息不泄露私钥', async () => {
    const query = new URLSearchParams({ mode: 'express', location: 'global', model: 'gemini-test' });
    const response = await sendVertexRequest(query, { apiKey: 'fake key', request: {} }, new AbortController().signal, async (url, init) => {
        assert.equal(new URL(url).hostname, 'aiplatform.googleapis.com');
        assert.equal(new URL(url).pathname, '/v1/publishers/google/models/gemini-test:generateContent');
        assert.equal(new URL(url).searchParams.get('key'), 'fake key');
        assert.equal(init.headers.Authorization, undefined); return Response.json({ ok: true });
    });
    assert.equal(response.status, 200);
    query.set('location', 'evil.invalid/');
    await assert.rejects(sendVertexRequest(query, { request: {} }, new AbortController().signal), /格式/);
    const bad = { ...serviceAccount, client_email: 'bad@example.com' };
    await assert.rejects(vertexAccessToken(bad, new AbortController().signal, async () => Response.json({ error: serviceAccount.private_key }, { status: 400 })), e => e.status === 401 && !e.message.includes('PRIVATE KEY'));
    const { POST } = await import('../app/api/vertex/route.ts');
    const denied = await POST(new Request('https://phone.test/api/vertex', { method: 'POST', headers: { origin: 'https://other.test' }, body: '{}' }));
    assert.equal(denied.status, 403);
});

await test('Vertex 区分鉴权与模型上游 504，保留状态且不返回 HTML 或凭据', async () => {
    const secretHtml = '<HTML>Inactivity Timeout PRIVATE KEY fake-secret</HTML>';
    const upstream504 = async () => new Response(secretHtml, {status: 504});
    await assert.rejects(vertexAccessToken({...serviceAccount, client_email:'timeout@example.com'}, new AbortController().signal, upstream504), error => {
        assert.equal(error.status, 504); assert.equal(error.code, 'vertex_oauth_upstream_504');
        assert.match(error.message, /鉴权.*秒/); assert.ok(!error.message.includes('PRIVATE')); return true;
    });
    const query = new URLSearchParams({mode:'full', project:'test-project', location:'global', model:'gemini-3.8-flash'});
    await assert.rejects(sendVertexRequest(query, {serviceAccount, request:{}}, new AbortController().signal, async url => url.includes('oauth2') ? Response.json({access_token:'fake-token',expires_in:3600}) : upstream504()), error => {
        assert.equal(error.status,504); assert.equal(error.code,'vertex_model_upstream_504');
        assert.match(error.message,/模型.*秒/); assert.ok(!error.message.includes('<HTML>')); return true;
    });
    const timedOut = new AbortController(); timedOut.abort(new DOMException('deadline','TimeoutError'));
    await assert.rejects(sendVertexRequest(new URLSearchParams({mode:'express',model:'gemini-3.8-flash'}),{apiKey:'fake-secret',request:{}},timedOut.signal,async()=>{throw timedOut.signal.reason;}), error => error.status === 504 && error.code === 'vertex_model_timeout');
});

await test('Vertex 未导入账号与 JSON 格式错误分别提示，并接受 BOM', async () => {
    const { parseVertexServiceAccount } = await import('../lib/vertex-config.ts');
    assert.throws(() => parseVertexServiceAccount('  '), /尚未导入服务账号/);
    assert.throws(() => parseVertexServiceAccount('{bad'), /JSON 格式不正确/);
    assert.throws(() => parseVertexServiceAccount('{"project_id":"x"}'), /client_email/);
    assert.equal(parseVertexServiceAccount('\uFEFF' + JSON.stringify(serviceAccount)).project_id, serviceAccount.project_id);
    const result = await simpleLLMCall({ ...vertexConfig, vertexServiceAccount: '' }, [{ role: 'user', content: 'hi' }]);
    assert.match(result.error, /尚未导入服务账号/);
});

const { checkPhoneUpdate, syncPhoneFork, normalizeUpdateRepository, UPDATE_REPOSITORY } = await import('../lib/phone-update.ts');
const oldSha = 'a'.repeat(40), latestSha = 'b'.repeat(40);
await test('软件更新区分页面待刷新、上游新版、当前版、自定义分支和未知构建', async () => {
    const response = (data) => Response.json(data);
    const newerDeployment = await checkPhoneUpdate('', oldSha, undefined, async url => {
        assert.ok(String(url).startsWith('/api/app-version')); return response({ sha: latestSha });
    });
    assert.equal(newerDeployment.state, 'refresh');
    for (const [deployed, comparison, state] of [[oldSha,'ahead','available'],[latestSha,'identical','current'],[oldSha,'diverged','custom'],['','ahead','unknown']]) {
        const result = await checkPhoneUpdate('', deployed, undefined, async url => {
            if (String(url).startsWith('/api/app-version')) return response({ sha: deployed });
            if (String(url).includes('/compare/')) return response({ status: comparison });
            return response({ sha: latestSha, commit: { message: 'Update test' } });
        });
        assert.equal(result.state,state);
    }
});
await test('软件更新只向 GitHub 发送授权并验证 Fork，快进同步后复核 SHA', async () => {
    let current = oldSha, writes = 0;
    const fetcher = async (url, init) => {
        const u = new URL(url); assert.equal(u.origin,'https://api.github.com');
        assert.equal(init.headers.Authorization,'Bearer fake-update-token');
        if (u.pathname.includes('/commits/')) return Response.json({ sha:latestSha });
        if (u.pathname.endsWith('/repos/test-user/phone')) return Response.json({ full_name:'test-user/phone',fork:true,source:{full_name:UPDATE_REPOSITORY},permissions:{push:true} });
        if (u.pathname.includes('/compare/')) return Response.json({ status:'ahead' });
        if (init.method === 'PATCH') { assert.deepEqual(JSON.parse(init.body),{sha:latestSha,force:false});writes++;current=latestSha; }
        return Response.json({object:{sha:current}});
    };
    assert.deepEqual(await syncPhoneFork('https://github.com/test-user/phone.git','fake-update-token',latestSha,undefined,fetcher),{sha:latestSha,changed:true});
    assert.equal(writes,1);
    assert.deepEqual(await syncPhoneFork('test-user/phone','fake-update-token',latestSha,undefined,fetcher),{sha:latestSha,changed:false});
    assert.equal(writes,1);
});
await test('软件更新拒绝错误来源、无权限、分叉、上游竞态和无效仓库，不执行写入', async () => {
    assert.throws(()=>normalizeUpdateRepository('https://evil.test/a/b'),/仓库/);
    for (const scenario of ['wrong-source','no-permission','diverged','changed-source','unauthorized']) {
        let writes=0;
        const fetcher=async (url,init) => {
            if(init.method==='PATCH')writes++;
            if(scenario==='unauthorized')return Response.json({}, {status:401});
            if(url.includes('/commits/'))return Response.json({sha:scenario==='changed-source'?oldSha:latestSha});
            if(url.endsWith('/repos/test-user/phone'))return Response.json({full_name:'test-user/phone',fork:true,source:{full_name:scenario==='wrong-source'?'xiaolongbao0709/ai-virtual-phone':UPDATE_REPOSITORY},permissions:{push:scenario!=='no-permission'}});
            if(url.includes('/compare/'))return Response.json({status:'diverged'});
            return Response.json({object:{sha:oldSha}});
        };
        await assert.rejects(syncPhoneFork('test-user/phone','fake',latestSha,undefined,fetcher));
        assert.equal(writes,0);
    }
    await assert.rejects(syncPhoneFork('test-user/phone','',latestSha),/首次更新/);
});
await test('软件更新并发写入被 GitHub 拒绝时不强推，网络失败不误报最新', async () => {
    let writes=0;
    await assert.rejects(syncPhoneFork('test-user/phone','fake',latestSha,undefined,async (url,init)=>{
        if(url.includes('/commits/'))return Response.json({sha:latestSha});
        if(url.endsWith('/repos/test-user/phone'))return Response.json({full_name:'test-user/phone',fork:true,source:{full_name:UPDATE_REPOSITORY},permissions:{push:true}});
        if(url.includes('/compare/'))return Response.json({status:'ahead'});
        if(init.method==='PATCH'){writes++;assert.equal(JSON.parse(init.body).force,false);return Response.json({}, {status:422});}
        return Response.json({object:{sha:oldSha}});
    }),/未强制覆盖/);
    assert.equal(writes,1);
    await assert.rejects(checkPhoneUpdate('',oldSha,undefined,async()=>{throw new Error('offline');}),/offline/);
});

await test('代理部署同源请求通过，跨站、同站异源和伪造转发头仍被拒绝', async () => {
    const { isSameOriginRequest } = await import('../lib/same-origin-request.ts');
    const request = headers => new Request('http://internal:3000/api/vertex', {method:'POST', headers});
    assert.equal(isSameOriginRequest(request({origin:'https://phone.example', 'sec-fetch-site':'same-origin'})), true);
    for (const site of ['cross-site', 'same-site']) {
        assert.equal(isSameOriginRequest(request({origin:'https://evil.example', 'sec-fetch-site':site})), false);
        assert.equal(isSameOriginRequest(request({'sec-fetch-site':site})), false);
    }
    assert.equal(isSameOriginRequest(request({origin:'null', 'sec-fetch-site':'same-origin'})), false);
    assert.equal(isSameOriginRequest(request({origin:'https://evil.example', 'x-forwarded-host':'evil.example'})), false);
    assert.equal(isSameOriginRequest(request({origin:'http://internal:3000'})), true);
    assert.equal(isSameOriginRequest(request({origin:'invalid'})), false);
    // Exercise both real route handlers without contacting Google or another paid API.
    for (const path of ['../app/api/vertex/route.ts', '../app/api/model-request/route.ts']) {
        const { POST } = await import(path);
        const cross = await POST(request({origin:'https://evil.example', 'sec-fetch-site':'cross-site'}));
        assert.equal(cross.status,403);
        const local = await POST(new Request('http://internal:3000/api/vertex', {
            method:'POST', headers:{origin:'https://phone.example','sec-fetch-site':'same-origin','content-type':'application/json'}, body:'{}'
        }));
        assert.notEqual(local.status,403);
    }
});
await test('Vertex 导入修复 JSON 误填项目，保留有效覆盖值，发送前拒绝无效项目且不泄漏密钥到 URL', async () => {
    const { projectAfterVertexImport, vertexRequestUrl } = await import('../lib/vertex-config.ts');
    const account = JSON.stringify({type:'service_account',project_id:'test-project',client_email:'test@example.com',private_key:'-----BEGIN PRIVATE KEY-----test'});
    assert.equal(projectAfterVertexImport(account,'test-project'),'test-project');
    assert.equal(projectAfterVertexImport('other-project','test-project'),'other-project');
    assert.equal(projectAfterVertexImport('','test-project'),'test-project');
    const config = {id:'project-test',apiKey:'',defaultModel:'test-model',vertexMode:'full',vertexServiceAccount:account,vertexProject:account};
    assert.throws(()=>vertexRequestUrl(config),/不能粘贴整段 JSON/);
    const url = vertexRequestUrl({...config,vertexProject:projectAfterVertexImport(account,'test-project')});
    assert.equal(new URL(url,'https://phone.example').searchParams.get('project'),'test-project');
    assert.ok(!url.includes('PRIVATE'));
});

await test('Vertex 默认直传兼容旧保活客户端，延迟 JSON/SSE 不改写；保活需服务端显式开启', async () => {
    const { POST } = await import('../app/api/vertex/route.ts');
    const { unwrapModelResponse } = await import('../lib/model-response-tunnel.ts');
    const previousFetch = globalThis.fetch;
    const previousTunnel = process.env.VERTEX_RESPONSE_TUNNEL;
    const makeRequest = (stream = false) => new Request(`https://phone.test/api/vertex?mode=express&model=gemini-test&stream=${stream}`, {method:'POST',headers:{origin:'https://phone.test','content-type':'application/json','x-phone-stream':'1'},body:JSON.stringify({apiKey:'fake',request:{contents:[]}})});
    try {
        delete process.env.VERTEX_RESPONSE_TUNNEL;
        for (const stream of [false,true]) {
            const contentType = stream ? 'text/event-stream' : 'application/json';
            const content = stream ? 'data: {"text":"你好"}\n\n' : JSON.stringify({candidates:[{content:{parts:[{text:'你好'}]}}]});
            let calls=0;
            globalThis.fetch = async url => {
                calls++; assert.equal(new URL(url).hostname,'aiplatform.googleapis.com');
                await new Promise(resolve=>setTimeout(resolve,30));
                return new Response(new ReadableStream({start(controller){setTimeout(()=>{controller.enqueue(new TextEncoder().encode(content));controller.close();},20);}}),{headers:{'content-type':contentType}});
            };
            const response = await POST(makeRequest(stream));
            assert.equal(response.headers.get('x-phone-response-tunnel'),null);
            const restored = await unwrapModelResponse(response);
            assert.equal(restored.headers.get('content-type'),contentType);
            assert.equal(await restored.text(),content);assert.equal(calls,1);
        }
        globalThis.fetch = async()=>new Response('<HTML>timeout</HTML>',{status:504});
        const failure=await unwrapModelResponse(await POST(makeRequest()));
        assert.equal(failure.status,504);assert.equal((await failure.json()).error.code,'vertex_model_upstream_504');
        process.env.VERTEX_RESPONSE_TUNNEL='true';
        globalThis.fetch=async()=>Response.json({ok:true});
        const tunneled=await POST(makeRequest());
        assert.equal(tunneled.headers.get('x-phone-response-tunnel'),'1');
        assert.deepEqual(await (await unwrapModelResponse(tunneled)).json(),{ok:true});
        for (const tunnel of ['true', 'false']) {
            process.env.VERTEX_RESPONSE_TUNNEL=tunnel;
            let calls=0;
            globalThis.fetch=async()=>{calls++;return Response.json({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'capacity'}},{status:429,headers:{'retry-after':'17'}});};
            const limited=await unwrapModelResponse(await POST(makeRequest()));
            assert.equal(limited.status,429);
            assert.equal(limited.headers.get('retry-after'),'17');
            assert.equal((await limited.json()).error.status,'RESOURCE_EXHAUSTED');
            assert.equal(calls,1);
        }
        await assert.rejects(unwrapModelResponse(new Response('\n\n',{headers:{'x-phone-response-tunnel':'1'}})),/提前中断.*未收到上游状态/);
    } finally {
        globalThis.fetch=previousFetch;
        if(previousTunnel===undefined) delete process.env.VERTEX_RESPONSE_TUNNEL;
        else process.env.VERTEX_RESPONSE_TUNNEL=previousTunnel;
    }
});

await test('Vertex 等待上游时立即发送保活，非流式状态和中文表情完整还原', async () => {
    const { keepAliveModelResponse, unwrapModelResponse } = await import('../lib/model-response-tunnel.ts');
    let release;
    const response = keepAliveModelResponse(() => new Promise(resolve => {release=resolve;}), new AbortController().signal, 5);
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value),'\n');
    assert.equal(new TextDecoder().decode((await reader.read()).value),'\n');
    release(Response.json({candidates:[{content:{parts:[{text:'晚安[表情包:小猫挥手]🐱'}]}}]}));
    // Reattach the remaining framed bytes after checking heartbeats.
    const rest = new ReadableStream({async pull(controller){const part=await reader.read();if(part.done)controller.close();else controller.enqueue(part.value);}});
    const restored = await unwrapModelResponse(new Response(rest,{headers:response.headers}));
    assert.equal(restored.status,200);
    assert.equal((await restored.json()).candidates[0].content.parts[0].text,'晚安[表情包:小猫挥手]🐱');
    for(const status of [400,401,403,429,504]){
        const original = {error:{message:'upstream failure'}};
        const result = await unwrapModelResponse(keepAliveModelResponse(async()=>Response.json(original,{status}),new AbortController().signal));
        assert.equal(result.status,status);assert.deepEqual(await result.json(),original);
    }
});
await test('Vertex 保活保持 SSE 字节内容，取消会中止上游，截断不误报成功', async () => {
    const { keepAliveModelResponse, unwrapModelResponse } = await import('../lib/model-response-tunnel.ts');
    const text='data: {"text":"你好🐱[表情包:挥手]"}\n\ndata: [DONE]\n\n';
    const bytes=new TextEncoder().encode(text);
    const stream=new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));controller.close();}});
    const result=await unwrapModelResponse(keepAliveModelResponse(async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}}),new AbortController().signal));
    assert.equal(result.headers.get('content-type'),'text/event-stream');assert.equal(await result.text(),text);
    let upstreamSignal;
    const waiting=keepAliveModelResponse(signal=>{upstreamSignal=signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled'))));},new AbortController().signal);
    const reader=waiting.body.getReader();await reader.read();await reader.cancel();assert.equal(upstreamSignal.aborted,true);
    const truncated=new Response('{"type":"head","status":200}\n{"type":"data","text":"partial"}\n',{headers:{'x-phone-response-tunnel':'1'}});
    const partial=await unwrapModelResponse(truncated);await assert.rejects(partial.text(),/提前中断/);
    const gateway=await unwrapModelResponse(new Response('<HTML>Inactivity Timeout</HTML>',{status:504}));
    assert.equal(gateway.status,504);assert.ok(!(await gateway.text()).includes('<HTML>'));
});
await test('工具诊断执行两轮非流式请求，保留签名，不执行外部动作且不吞掉 504', async () => {
    const {testModelTools} = await import('../lib/model-tool-test.ts');
    const config={id:'probe',provider:'VertexAI',protocol:'vertex',vertexMode:'express',apiKey:'fake',defaultModel:'gemini-3.8-flash'};
    let calls=0;
    const result=await testModelTools(config,async payload=>{
        assert.equal(new URL(payload.url,'http://local').searchParams.get('stream'),'false');
        calls++;
        if(calls===1) return Response.json({candidates:[{content:{parts:[{thoughtSignature:'probe-signature',functionCall:{id:'probe-id',name:'phone_connection_probe',args:{}}}]}}]});
        assert.match(JSON.stringify(payload.body),/probe-signature/);
        assert.match(JSON.stringify(payload.body),/functionResponse/);
        assert.match(JSON.stringify(payload.body),/PHONE_TOOL_OK/);
        return Response.json({candidates:[{content:{parts:[{text:'PHONE_TOOL_OK'}]}}]});
    });
    assert.equal(calls,2);assert.match(result,/工具测试成功/);
    await assert.rejects(testModelTools(config,async()=>Response.json({error:{message:'upstream timeout'}},{status:504})),/API Tool Error 504/);
    await assert.rejects(testModelTools(config,async()=>Response.json({candidates:[{content:{parts:[{text:'hello'}]}}]})),/工具链尚未验证/);
});

await test('表情包结尾保持为 Gemini 正文，不凭空产生工具调用', async () => {
    const text='晚安[表情包:小猫挥手]';
    const result=parseProviderResponse('gemini',{candidates:[{content:{parts:[{text}]},finishReason:'STOP'}]});
    assert.equal(result.content,text);assert.deepEqual(result.toolCalls,[]);
});

await test('Vertex 流式断连不得误报成功；结束标记、错误和取消均保留', async () => {
    const {validateVertexStream}=await import('../lib/vertex-stream.ts');
    const partial='data: {"candidates":[{"content":{"parts":[{"text":"你好🐱"}]}}]}\r\n\r\n';
    const end='data: {"candidates":[{"finishReason":"STOP"}]}\r\n\r\n';
    const bytes=new TextEncoder().encode(partial+end);
    const source=new ReadableStream({start(c){for(const b of bytes)c.enqueue(Uint8Array.of(b));c.close();}});
    assert.equal(await validateVertexStream(new Response(source)).text(),partial+end);
    for(const text of [partial,partial+'data: {"candidates":[{"finishReason":"ST']) {
        await assert.rejects(validateVertexStream(new Response(text)).text(),/未收到生成结束标记/);
    }
    await assert.rejects(validateVertexStream(new Response('data: {"error":{"code":429}}\n\n')).text(),/API Stream 429/);
    const limited=Response.json({error:'limited'},{status:429});
    assert.equal(validateVertexStream(limited),limited);
    let cancelled=false;
    const waiting=new ReadableStream({cancel(){cancelled=true;}});
    await validateVertexStream(new Response(waiting)).body.cancel();
    assert.equal(cancelled,true);
});

const { createDisplayFilterRules, bindDisplayFilterToAllChats } = await import('../lib/regex-display-filter.ts');
const { applyDisplayRegex, applyOutputRegex } = await import('../lib/llm-prompt-assembler.ts');
const { resolveBinding, parseRegexFromJson } = await import('../lib/settings-storage.ts');
const filterGroup = (input, mode = 'words') => ({ id: 'filter', name: '隐藏', createdAt: 0, updatedAt: 0, rules: createDisplayFilterRules(input, mode, 'rule') });
await test('字词隐藏逐字匹配、长词优先、重复出现与特殊标点', () => {
    const group = filterGroup('某词\n某词组\na.b\n[状态]\n/path/\n某词\n');
    const text = '某词组某词 a.b axb [状态] /path/某词';
    assert.equal(applyDisplayRegex(text, [group], 2, { activeTags: ['chat', 'text'] }), '  axb  ');
    assert.throws(() => createDisplayFilterRules(' \n ', 'words', 'r'), /填写/);
});
await test('隐藏只在 AI 正文显示生效，不改用户消息、思考、存储输出和提示词', () => {
    const group = filterGroup('秘密');
    const original = '这是秘密';
    for (const tags of [['chat','text'], ['chat','offline'], ['group_chat','text'], ['group_chat','offline']]) {
        const ctx = { activeTags: tags };
        assert.equal(applyDisplayRegex(original, [group], 2, ctx), '这是');
        assert.equal(applyDisplayRegex(original, [group], 1, ctx), original);
        assert.equal(applyDisplayRegex(original, [group], 6, ctx), original);
        assert.equal(applyOutputRegex(original, [group], ctx), original);
        assert.equal(applyOutputRegex(original, [group], { ...ctx, isPrompt: true }), original);
    }
    assert.equal(applyDisplayRegex(original, [group], 2, { activeTags: ['story'] }), original);
    const disabled = { ...group, rules: group.rules.map(rule => ({ ...rule, disabled: true })) };
    assert.equal(applyDisplayRegex(original, [disabled], 2, { activeTags: ['chat','text'] }), original);
    const restored = parseRegexFromJson(JSON.stringify(group));
    assert.equal(applyDisplayRegex(original, [restored], 2, { activeTags: ['chat','offline'] }), '这是');
});
await test('高级隐藏规则支持 flags、跨行和非法表达式校验', () => {
    const ctx = { activeTags: ['chat','text'] };
    assert.equal(applyDisplayRegex('FOO foo', [filterGroup('/foo/gi', 'regex')], 2, ctx), ' ');
    assert.equal(applyDisplayRegex('foo foo', [filterGroup('/foo/', 'regex')], 2, ctx), ' foo');
    assert.equal(applyDisplayRegex('a<hide>一\n二</hide>b', [filterGroup('/<hide>.*?<\\/hide>/gs', 'regex')], 2, ctx), 'ab');
    assert.throws(() => filterGroup('/[bad/g', 'regex'), /无效/);
    assert.throws(() => filterGroup('/foo/gg', 'regex'), /无效/);
    assert.throws(() => filterGroup('/(a+)+$/', 'regex'), /卡住/);
    assert.throws(() => filterGroup('/(a|b)\\1/', 'regex'), /卡住/);
    const legacy = { ...filterGroup('safe'), rules: [{ ...filterGroup('safe').rules[0], findRegex: '/(a+)+$/' }] };
    assert.equal(applyDisplayRegex('a'.repeat(31) + '!', [legacy], 2, ctx), 'a'.repeat(31) + '!');
    assert.equal(applyDisplayRegex('x\\1y', [filterGroup('\\1')], 2, ctx), 'xy');
});
await test('快捷隐藏自动追加绑定，保留已有覆盖、API 和继承关系', () => {
    const original = {
        globalDefaults: { regexIds: ['global'], apiConfigId: 'api' },
        appDefaults: { chat: { regexIds: ['app'] } },
        characterBindings: [
            { characterId: 'alice', defaults: { regexIds: ['alice'] }, appOverrides: { chat: { regexIds: ['specific'], presetId: 'preset' } } },
            { characterId: 'bob', defaults: {}, appOverrides: {} },
        ],
    };
    const copy = structuredClone(original);
    const next = bindDisplayFilterToAllChats(original, 'filter');
    assert.deepEqual(original, copy);
    assert.deepEqual(resolveBinding(next, 'alice', 'chat').regexIds, ['specific','filter']);
    assert.deepEqual(resolveBinding(next, 'bob', 'chat').regexIds, ['app','filter']);
    assert.deepEqual(resolveBinding(next, undefined, 'group_chat').regexIds, ['global','filter']);
    assert.deepEqual(resolveBinding(next, 'alice', 'offline').regexIds, ['alice','filter']);
    assert.equal(resolveBinding(next, 'alice', 'chat').apiConfigId, 'api');
    assert.equal(resolveBinding(next, 'alice', 'chat').presetId, 'preset');
    assert.deepEqual(next.characterBindings[1].defaults, {});
    assert.deepEqual(bindDisplayFilterToAllChats(next, 'filter'), next);
});

console.log(`\n${passed} compatibility checks passed (mock APIs; no paid requests).`);
