import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openControl } from "../control/store";
import { ensureAdapterSchema } from "../adapters/store";
import { conversationRoute } from "./conversation-routes";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshControl(): string {
  const root = mkdtempSync(join(tmpdir(), "conv-routes-"));
  roots.push(root);
  const path = join(root, "control.db");
  return path;
}

function seedConversations(
  db: Database,
  n: number,
): { id: string; created_at: number }[] {
  const seeded: { id: string; created_at: number }[] = [];
  for (let i = 0; i < n; i++) {
    const id = `conv-${i}`;
    // spread across 2 timestamps to exercise tie-break order
    const t = 1_000_000 + (i % 2);
    db.run(
      "INSERT INTO conversations(id,binding_key,address,owner_id,session_reference,work_id,coordinator_work_id,provider,model,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        `bk-${i}`,
        JSON.stringify({ instanceId: "i", tenantId: "t", chatId: `c${i}` }),
        "owner",
        JSON.stringify({ runtimeKind: "bun", sessionId: `s${i}`, ownerId: "owner", cwd: "/tmp" }),
        `w${i}`,
        `cw${i}`,
        "p",
        "m",
        t,
      ],
    );
    seeded.push({ id, created_at: t });
  }
  return seeded;
}

function seedTurns(
  db: Database,
  conversationId: string,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    db.run(
      "INSERT INTO conversation_turns(id,conversation_id,sequence,text,state,created_at) VALUES(?,?,?,?,?,?)",
      [
        `turn-${conversationId}-${i}`,
        conversationId,
        i,
        `text-${i}`,
        "running",
        2_000_000 + i,
      ],
    );
  }
}

async function callRoute(
  method: string,
  path: string,
  controlPath: string,
): Promise<Response | null> {
  const url = new URL(path, "http://localhost");
  return conversationRoute(new Request(url, { method }), url, { controlPath });
}

test("list returns up to 50 items by default with parsed address/session_reference and last_sequence", async () => {
  const controlPath = freshControl();
  const db = openControl(controlPath);
  ensureAdapterSchema(db);
  const seeded = seedConversations(db, 65);
  seedTurns(db, seeded[0].id, 3);
  seedTurns(db, seeded[2].id, 1);
  db.close();

  const resp = await callRoute("GET", "/api/conversations", controlPath);
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(200);
  const body = (await resp!.json()) as { items: Array<{ id: string; address: object; session_reference: object; last_sequence: number | null; turns?: unknown[]; text?: string }>; next_cursor: string | null };
  expect(body.items.length).toBe(50);
  const first = body.items[0];
  // Parsed address is an object, not a string
  expect(typeof first.address).toBe("object");
  expect(first.address).toMatchObject({ instanceId: "i", tenantId: "t" });
  expect(typeof first.session_reference).toBe("object");
  expect(first.session_reference).toMatchObject({ runtimeKind: "bun" });
  // last_sequence populated from subquery MAX(sequence)
  expect(body.items.find(x => x.id === seeded[0].id)!.last_sequence).toBe(2);
  expect(body.items.find(x => x.id === seeded[2].id)!.last_sequence).toBe(0);
  expect(body.items.find(x => x.id === seeded[1].id)!.last_sequence).toBeNull();
  // No turns/text/output in list
  expect((first as Record<string, unknown>).turns).toBeUndefined();
  expect((first as Record<string, unknown>).text).toBeUndefined();
  expect(body.next_cursor).not.toBeNull();
});

test("list pagination keyset stability with duplicate created_at values", async () => {
  const controlPath = freshControl();
  const db = openControl(controlPath);
  ensureAdapterSchema(db);
  // 4 items all at same created_at, distinct ids
  const t = 5_000_000;
  const ids = ["z-last", "a-first", "m-mid", "n-mid2"];
  ids.forEach((id, i) => {
    db.run(
      "INSERT INTO conversations(id,binding_key,address,owner_id,created_at) VALUES(?,?,?,?,?)",
      [id, `bk-${i}`, JSON.stringify({ instanceId: "i", tenantId: "t", chatId: id }), "owner", t],
    );
  });
  db.close();

  // Page size 2, walk through
  let cursor: string | null = null;
  const seen: string[] = [];
  for (let page = 0; page < 3; page++) {
    const p = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
    const resp = await callRoute("GET", `/api/conversations${p}`, controlPath);
    expect(resp!.status).toBe(200);
    const body = (await resp!.json()) as { items: { id: string }[]; next_cursor: string | null };
    expect(body.items.length).toBe(page === 2 ? 0 : 2);
    for (const it of body.items) seen.push(it.id);
    cursor = body.next_cursor;
    if (!cursor) break;
  }
  // Expected stable order: ids ASC since all same created_at
  expect(seen).toEqual(["a-first", "m-mid", "n-mid2", "z-last"]);
});

test("invalid limit and invalid cursor return 400", async () => {
  const controlPath = freshControl();
  // no rows needed for validation tests
  const r1 = await callRoute("GET", "/api/conversations?limit=0", controlPath);
  expect(r1!.status).toBe(400);

  const r2 = await callRoute("GET", "/api/conversations?limit=200", controlPath);
  expect(r2!.status).toBe(400);

  const r3 = await callRoute("GET", "/api/conversations?limit=1.5", controlPath);
  expect(r3!.status).toBe(400);

  const r4 = await callRoute("GET", "/api/conversations?limit=abc", controlPath);
  expect(r4!.status).toBe(400);

  const r5 = await callRoute(
    "GET",
    "/api/conversations?cursor=!!!not-base64url!!!",
    controlPath,
  );
  expect(r5!.status).toBe(400);

  const r6 = await callRoute(
    "GET",
    "/api/conversations?cursor=" + Buffer.from('{"t":123}').toString("base64url"),
    controlPath,
  );
  expect(r6!.status).toBe(400);
});

test("turns default returns latest turns up to limit in ascending order, next_before set when more exist", async () => {
  const controlPath = freshControl();
  const db = openControl(controlPath);
  ensureAdapterSchema(db);
  db.run(
    "INSERT INTO conversations(id,binding_key,address,owner_id,created_at) VALUES(?,?,?,?,?)",
    ["c1", "bk", JSON.stringify({ instanceId: "i", tenantId: "t", chatId: "c" }), "owner", 100],
  );
  seedTurns(db, "c1", 20);
  db.close();

  const resp = await callRoute(
    "GET",
    "/api/conversations/c1/turns?limit=5",
    controlPath,
  );
  expect(resp!.status).toBe(200);
  const body = (await resp!.json()) as {
    conversation: { id: string };
    turns: { sequence: number }[];
    next_before: number | null;
    next_after: number | null;
  };
  expect(body.conversation.id).toBe("c1");
  expect(body.turns.length).toBe(5);
  expect(body.turns.map((t) => t.sequence)).toEqual([15, 16, 17, 18, 19]);
  expect(body.next_before).toBe(15);
  expect(body.next_after).toBeNull();
});

test("turns pagination with before progresses to older turns and eventually null", async () => {
  const controlPath = freshControl();
  const db = openControl(controlPath);
  ensureAdapterSchema(db);
  db.run(
    "INSERT INTO conversations(id,binding_key,address,owner_id,created_at) VALUES(?,?,?,?,?)",
    ["c1", "bk", JSON.stringify({ instanceId: "i", tenantId: "t", chatId: "c" }), "owner", 100],
  );
  seedTurns(db, "c1", 10);
  db.close();

  const allSequences: number[] = [];
  let before: number | null = null;
  for (let p = 0; p < 5; p++) {
    const path = before
      ? `/api/conversations/c1/turns?limit=3&before=${before}`
      : `/api/conversations/c1/turns?limit=3`;
    const resp = await callRoute("GET", path, controlPath);
    expect(resp!.status).toBe(200);
    const body = (await resp!.json()) as {
      turns: { sequence: number }[];
      next_before: number | null;
    };
    allSequences.push(...body.turns.map((t) => t.sequence));
    if (!body.next_before) break;
    before = body.next_before;
  }
  expect(allSequences).toEqual([7, 8, 9, 4, 5, 6, 1, 2, 3, 0]);
});

test("turns pagination with after retrieves new rows in ascending order", async () => {
  const controlPath = freshControl();
  const db = openControl(controlPath);
  ensureAdapterSchema(db);
  db.run(
    "INSERT INTO conversations(id,binding_key,address,owner_id,created_at) VALUES(?,?,?,?,?)",
    ["c1", "bk", JSON.stringify({ instanceId: "i", tenantId: "t", chatId: "c" }), "owner", 100],
  );
  seedTurns(db, "c1", 10);
  db.close();

  // after=2 returns sequences > 2: [3..9]
  const resp = await callRoute(
    "GET",
    "/api/conversations/c1/turns?limit=4&after=2",
    controlPath,
  );
  expect(resp!.status).toBe(200);
  const body = (await resp!.json()) as {
    turns: { sequence: number }[];
    next_before: number | null;
    next_after: number | null;
  };
  expect(body.turns.map((t) => t.sequence)).toEqual([3, 4, 5, 6]);
  expect(body.next_after).toBe(6);
  expect(body.next_before).toBeNull();

  // Walking further with after=6
  const resp2 = await callRoute(
    "GET",
    "/api/conversations/c1/turns?limit=4&after=6",
    controlPath,
  );
  const body2 = (await resp2!.json()) as {
    turns: { sequence: number }[];
    next_after: number | null;
  };
  expect(body2.turns.map((t) => t.sequence)).toEqual([7, 8, 9]);
  expect(body2.next_after).toBeNull();
});

test("before and after together returns 400, and invalid numeric params return 400", async () => {
  const controlPath = freshControl();
  const r1 = await callRoute(
    "GET",
    "/api/conversations/c1/turns?before=1&after=2",
    controlPath,
  );
  expect(r1!.status).toBe(400);

  const r2 = await callRoute(
    "GET",
    "/api/conversations/c1/turns?before=-1",
    controlPath,
  );
  expect(r2!.status).toBe(400);

  const r3 = await callRoute(
    "GET",
    "/api/conversations/c1/turns?before=0",
    controlPath,
  );
  expect(r3!.status).toBe(400);

  const r4 = await callRoute(
    "GET",
    "/api/conversations/c1/turns?after=-1",
    controlPath,
  );
  expect(r4!.status).toBe(400);
});

test("non-existent conversation returns 404", async () => {
  const controlPath = freshControl();
  const resp = await callRoute(
    "GET",
    "/api/conversations/does-not-exist/turns",
    controlPath,
  );
  expect(resp!.status).toBe(404);
  expect((await resp!.json()).error).toBe("not_found");
});

test("turns do not cross conversation boundaries", async () => {
  const controlPath = freshControl();
  const db = openControl(controlPath);
  ensureAdapterSchema(db);
  db.run(
    "INSERT INTO conversations(id,binding_key,address,owner_id,created_at) VALUES(?,?,?,?,?)",
    ["c1", "bk1", JSON.stringify({ instanceId: "i", tenantId: "t", chatId: "c" }), "owner", 100],
  );
  db.run(
    "INSERT INTO conversations(id,binding_key,address,owner_id,created_at) VALUES(?,?,?,?,?)",
    ["c2", "bk2", JSON.stringify({ instanceId: "i", tenantId: "t", chatId: "c" }), "owner", 200],
  );
  seedTurns(db, "c1", 3);
  seedTurns(db, "c2", 5);
  db.close();

  const resp = await callRoute(
    "GET",
    "/api/conversations/c1/turns",
    controlPath,
  );
  expect(resp!.status).toBe(200);
  const body = (await resp!.json()) as { turns: { conversation_id: string }[] };
  expect(body.turns.every((t) => t.conversation_id === "c1")).toBe(true);
  expect(body.turns.length).toBe(3);
});

