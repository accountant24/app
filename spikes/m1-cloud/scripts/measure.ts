// Drives the deployed spike and prints what M1 measures. Each step is a subcommand, so steps can be rerun.
// Run: npm run measure -- <step>   (steps: init, chats, crash, forcepush, photo, status, all)

import { deflateSync } from "node:zlib";

const BASE = process.env.SPIKE_URL;
const TOKEN = process.env.SPIKE_TOKEN;
const BOOKS = process.env.SPIKE_BOOKS ?? "m1-test";
if (!BASE || !TOKEN) throw new Error("Set SPIKE_URL and SPIKE_TOKEN in .env");

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const t0 = Date.now();
  const response = await fetch(`${BASE}/books/${BOOKS}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 2000)}`);
  if (Array.isArray(value)) return { items: value, roundTripMs: Date.now() - t0 };
  return { ...(typeof value === "object" && value !== null ? value : { value }), roundTripMs: Date.now() - t0 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (label: string, value: unknown) => console.log(`\n## ${label}\n${JSON.stringify(value, null, 2)}`);

async function newChat(): Promise<string> {
  return (await call("POST", "/chats")).session;
}

/** Polls until the chat has nothing pending, then returns its last messages. */
async function settle(session: string, timeoutMs = 240_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const pending = await call("GET", `/chats/${session}/pending`);
      if (!Array.isArray(pending.items)) throw new Error(`Unexpected pending: ${JSON.stringify(pending).slice(0, 200)}`);
      if (pending.items.length === 0) break;
    } catch (error) {
      // The object may be restarting after a crash.
      console.log(`  (waiting: ${(error as Error).message.slice(0, 80)})`);
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`Chat ${session} didn't settle in ${timeoutMs} ms`);
    await sleep(2000);
  }
  const entries = (await call("GET", `/chats/${session}/messages`)).items as any[];
  return { session, settledAfterMs: Date.now() - t0, tail: entries.slice(-8).map(summarize) };
}

function summarize(entry: any) {
  const data = entry.model?.[0] ?? entry.data ?? entry;
  const content = data.content ?? data.message?.content;
  const text = Array.isArray(content)
    ? content.map((c: any) => c.text ?? (c.type === "toolCall" ? `[call ${c.name} ${JSON.stringify(c.arguments)}]` : `[${c.type}]`)).join(" ")
    : String(content ?? "");
  return `${entry.kind ?? data.role}: ${text.slice(0, 400)}`;
}

const steps: Record<string, () => Promise<void>> = {
  async init() {
    show("init: repo, container start, clone, seed, push", await call("POST", "/init"));
    show("status", await call("GET", "/status"));
  },

  async chats() {
    // Two chats at once on one container: one books and saves, one only reads.
    const [a, b] = await Promise.all([newChat(), newChat()]);
    const [booked, asked] = await Promise.all([
      call("POST", `/chats/${a}/prompt`, {
        text: "I paid $4.50 cash for a latte at Blue Bottle Coffee on 2026-09-20. Book it and save.",
      }),
      call("POST", `/chats/${b}/prompt`, { text: "How much did I spend on groceries in September 2026?" }),
    ]);
    show("chat A (book and save)", booked);
    show("chat B (read only, same container)", asked);
    show("journal tail", await call("POST", "/exec", { command: "tail -n 8 ledger/main.journal && git log --oneline -3" }));
  },

  async crash() {
    // A crash mid-tool in two chats: the replay-safe wait_safe reruns, the unsafe bash comes back interrupted.
    const [safe, unsafe] = await Promise.all([newChat(), newChat()]);
    await Promise.all([
      call("POST", `/chats/${safe}/prompt`, { wait: false, text: "Call wait_safe with seconds=25, then tell me its exact output." }),
      call("POST", `/chats/${unsafe}/prompt`, {
        wait: false,
        text: "Run this exact bash command once: sleep 25 && echo unsafe-finished. Then tell me its exact output.",
      }),
    ]);
    await sleep(12_000);
    show("crash", await call("POST", "/crash").catch((e) => ({ crashed: true, note: (e as Error).message.slice(0, 120) })));
    show("safe chat after the crash (expect wait_safe attempt 2)", await settle(safe));
    show("unsafe chat after the crash (expect an interrupted bash result)", await settle(unsafe));
  },

  async crashsafe() {
    const safe = await newChat();
    await call("POST", `/chats/${safe}/prompt`, { wait: false, text: "Call wait_safe with seconds=25, then tell me its exact output." });
    await sleep(12_000);
    await call("POST", "/crash").catch(() => undefined);
    show("safe chat after the crash (expect a rerun)", await settle(safe));
  },

  async noclient() {
    // Submit, crash, then send nothing for 60 s: only the harness's alarm can finish the run.
    const chat = await newChat();
    await call("POST", `/chats/${chat}/prompt`, { wait: false, text: "Call wait_safe with seconds=20, then tell me its exact output." });
    await sleep(8_000);
    await call("POST", "/crash").catch(() => undefined);
    console.log("crashed; no requests for 60 s");
    await sleep(60_000);
    const entries = (await call("GET", `/chats/${chat}/messages`)).items as any[];
    show("after 60 s with no client (expect the final answer already there)", entries.slice(-4).map(summarize));
  },

  async newtool() {
    // Chat 66 was created before ping_v2 existed.
    const ask = (label: string) =>
      call("POST", "/chats/66/prompt", { text: "Call the ping_v2 tool and tell me exactly what it returned. If you have no such tool, say so." })
        .then((r) => show(label, { text: r.result?.text, status: r.result?.status }));
    await ask("existing chat right after the deploy, object not restarted");
    await call("POST", "/crash").catch(() => undefined);
    await sleep(2000);
    await ask("existing chat after the object restarted");
  },

  async forcepush() {
    show("force push test", await call("POST", "/force-push-test"));
  },

  async photo() {
    // A photo over 2 MB, as a phone would send it unshrunk: does pi store it in a SQLite row?
    const width = 1000;
    const height = 800;
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
    const png = encodePng(width, height, raw);
    console.log(`PNG: ${(png.length / 1024 / 1024).toFixed(2)} MB`);
    const chat = await newChat();
    const result = await call("POST", `/chats/${chat}/prompt`, {
      text: [
        { type: "text", text: "What does this image show? One sentence." },
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      ],
    }).catch((e) => ({ error: (e as Error).message.slice(0, 1500) }));
    show("photo over 2 MB", result);
  },

  async status() {
    show("status", await call("GET", "/status"));
  },

  async all() {
    for (const step of ["init", "chats", "crash", "forcepush", "photo", "status"]) {
      console.log(`\n# ${step}`);
      await steps[step]!();
    }
  },
};

function encodePng(width: number, height: number, raw: Buffer): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const step = process.argv[2] ?? "status";
if (!steps[step]) throw new Error(`Unknown step "${step}". Steps: ${Object.keys(steps).join(", ")}`);
await steps[step]();
