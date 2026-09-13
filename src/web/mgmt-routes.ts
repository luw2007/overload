import { Database } from "bun:sqlite";
import { ControlError, openControl } from "../control/store";
import { loadManageConfig, scanOnce, listWorks, showWork, setTracking } from "../manage/manage";
import { checkHandoffPreconditions, createHandoff, launchHandoff, abandonHandoff, buildHandoffPacket } from "../manage/handoff";
import {
  computeManifest,
  insertManifest,
  listManifests,
  requestAcceptance,
  recordAcceptance,
  type Verification,
} from "../manage/manifest";
import { pollSubmissions, submitAcceptance } from "../manage/submit";
import { aliasWork, correctLink, workScope } from "../manage/relations";
import {
  localSourceFs,
  sshSourceFs,
  type SourceFs,
} from "../manage/source";

const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, ...init });
const body = async (r: Request) => { const x = await r.json(); if (!x || typeof x !== "object" || Array.isArray(x)) throw new ControlError("invalid", "JSON object required"); return x as Record<string, unknown>; };
const idOf = (s: string) => decodeURIComponent(s);
function sourceFor(control:Database, options:MgmtRouteOptions, workId:string):SourceFs {
  const scope=workScope(control,workId), execution=control.query(`SELECT stable_id FROM mgmt_executions WHERE work_id IN (${scope.map(()=>"?").join(",")}) ORDER BY last_observed_at DESC,started_at DESC,execution_id DESC LIMIT 1`).get(...scope) as {stable_id:string}|null;
  const cfg=loadManageConfig(options.overloadHome);
  let host=execution?.stable_id.split(":")[0];
  if(execution){const ledger=new Database(options.ledgerPath,{readonly:true});try{const row=ledger.query("SELECT host FROM sessions WHERE stable_id=?").get(execution.stable_id) as {host:string}|null;if(row)host=row.host;}finally{ledger.close();}}
  const source=cfg.hosts.find(h=>h.host===host)??(!execution?cfg.hosts.find(h=>h.kind==="local"):undefined);
  if(!source)throw new ControlError("conflict","source_host_unconfigured");
  return source.kind==="ssh"?sshSourceFs(source):localSourceFs(source);
}

export type MgmtRouteOptions = { controlPath: string; ledgerPath: string; overloadHome?: string };
export async function mgmtRoute(request: Request, url: URL, options: MgmtRouteOptions): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/mgmt/")) return null;
  const path = url.pathname;
  const m = path.match(/^\/api\/mgmt\/works\/([^/]+)(?:\/(track|handoff\/preconditions|handoffs))?$/);
  const handoff = path.match(/^\/api\/mgmt\/handoffs\/([^/]+)\/(launch|abandon|packet)$/,
  );
  const manifests = path.match(/^\/api\/mgmt\/works\/([^/]+)\/manifests$/);
  const acceptance = path.match(
    /^\/api\/mgmt\/manifests\/([^/]+)\/acceptance$/,
  );
  const submit = path.match(/^\/api\/mgmt\/acceptances\/([^/]+)\/submit$/);
  const correction=path.match(/^\/api\/mgmt\/links\/([^/]+)\/correct$/), alias=path.match(/^\/api\/mgmt\/works\/([^/]+)\/alias$/);
  const control = openControl(options.controlPath);
  try {
    if(request.method==="POST"&&(correction||alias)){
      const x=await body(request);
      if(typeof x.actor!=="string"||!x.actor.trim()||typeof x.reason!=="string"||!x.reason.trim())throw new ControlError("invalid","actor and reason required");
      if(alias){if(typeof x.canonical_work_id!=="string")throw new ControlError("invalid","canonical_work_id required");return json(aliasWork(control,idOf(alias[1]!),x.canonical_work_id,{actor:x.actor,reason:x.reason}));}
      if(typeof x.relation!=="string")throw new ControlError("invalid","relation required");
      if(x.confidence!==undefined&&x.confidence!=="strong"&&x.confidence!=="weak"&&x.confidence!=="uncertain")throw new ControlError("invalid","invalid confidence");
      return json(correctLink(control,idOf(correction![1]!),{relation:x.relation,object_id:typeof x.object_id==="string"?x.object_id:undefined,execution_id:typeof x.execution_id==="string"?x.execution_id:undefined,confidence:x.confidence as "strong"|"weak"|"uncertain"|undefined,actor:x.actor,reason:x.reason}));
    }
    if (request.method === "GET" && path === "/api/mgmt/works") {
      const track = url.searchParams.get("track") || "tracking";
      if (!["tracking", "paused", "archived"].includes(track)) return json({ error: "invalid track" }, { status: 400 });
      return json(listWorks(control, { track: track as "tracking"|"paused"|"archived" }));
    }
    if (manifests && request.method === "GET") {
      const workId = idOf(manifests[1]!);
      if (!showWork(control, workId))
        return json({ error: "not found" }, { status: 404 });
      return json(listManifests(control, workId));
    }
    if (manifests && request.method === "POST") {
      const workId = idOf(manifests[1]!),
        x = await body(request),
        work = showWork(control, workId);
      if (!work) return json({ error: "not found" }, { status: 404 });
      const verification = (x.verification ?? []) as Verification[];
      if (!Array.isArray(verification))
        throw new ControlError("invalid", "verification must be an array");
      const fs = sourceFor(control, options, workId),
        input = await computeManifest(control, fs, workId, { verification }),
        inserted = insertManifest(
          control,
          input,
          String(work.decision_owner),
          Date.now(),
        ),
        requested = requestAcceptance(
          control,
          inserted.manifest_id,
          Date.now(),
        );
      return json({ ...inserted, ...requested });
    }
    if (acceptance && request.method === "POST") {
      const manifestId = idOf(acceptance[1]!),
        x = await body(request);
      if (x.verdict !== "accepted" && x.verdict !== "rejected")
        throw new ControlError("invalid", "invalid verdict");
      const owner = control
        .query(
          "SELECT p.decision_owner FROM mgmt_manifests m JOIN mgmt_work_profile p USING(work_id) WHERE m.manifest_id=?",
        )
        .get(manifestId) as { decision_owner: string } | null;
      if (!owner) throw new ControlError("not_found", "manifest not found");
      return json(
        recordAcceptance(
          control,
          manifestId,
          x.verdict,
          owner.decision_owner,
          (x.evidence ?? {}) as Record<string, unknown>,
          Date.now(),
        ),
      );
    }
    if (submit && request.method === "POST") {
      const acceptanceId = idOf(submit[1]!),
        x = await body(request),
        row = control
          .query("SELECT work_id FROM mgmt_acceptances WHERE acceptance_id=?")
          .get(acceptanceId) as { work_id: string } | null;
      if (!row) throw new ControlError("not_found", "acceptance not found");
      const fs = sourceFor(control, options, row.work_id),
        result = await submitAcceptance(
          control,
          fs,
          acceptanceId,
          {
            target_kind: String(x.target_kind || ""),
            target: String(x.target || ""),
          },
          {
            recompute: (db, source, workId) =>
              computeManifest(db, source, workId, { verification: [] }),
          },
        );
      return json({
        submission_id: result.submission_id,
        state: result.state,
        external_ref: result.external_ref,
      });
    }
    if (request.method === "POST" && path === "/api/mgmt/submissions/poll")
      return json(await pollSubmissions(control, {}));
    if (m && request.method === "GET" && !m[2]) { const result = showWork(control, idOf(m[1]!)); return result ? json(result) : json({ error: "not found" }, { status: 404 }); }
    if (m && m[2] === "track" && request.method === "POST") { const x = await body(request); setTracking(control, idOf(m[1]!), x.on === true); return json({ ok: true }); }
    if (m && m[2] === "handoff/preconditions" && request.method === "GET") return json(checkHandoffPreconditions(control, null, idOf(m[1]!)));
    if (m && m[2] === "handoffs" && request.method === "POST") {
      const x = await body(request); if(!loadManageConfig(options.overloadHome).hosts.some(h=>h.host===String(x.target_host||"local")))throw new ControlError("conflict","target_host_unconfigured"); const result = createHandoff(control, null, idOf(m[1]!), { target_agent: x.target_agent as any, target_host: String(x.target_host || "local"), isolate: x.isolate === true, override_actor: typeof x.override_actor === "string" ? x.override_actor : undefined, override_reason: typeof x.override_reason === "string" ? x.override_reason : undefined });
      return json(result, { status: 201 });
    }
    if (handoff && request.method === "GET" && handoff[2] === "packet") return json(buildHandoffPacket(control, idOf(handoff[1]!)));
    if (handoff && request.method === "POST" && handoff[2] === "abandon") { const x = await body(request); abandonHandoff(control, idOf(handoff[1]!), String(x.reason || "abandoned")); return json({ ok: true }); }
    if (handoff && request.method === "POST" && handoff[2] === "launch") {
      const x = await body(request); if (x.confirmed !== true) return json({ error: "confirmed is required" }, { status: 400 });
      const row=control.query("SELECT target_host FROM mgmt_handoffs WHERE handoff_id=?").get(idOf(handoff[1]!)) as {target_host:string}|null;
      if(!row)throw new ControlError("not_found","handoff not found");
      const host=loadManageConfig(options.overloadHome).hosts.find(h=>h.host===row.target_host);
      if(!host)throw new ControlError("conflict","target_host_unconfigured");
      const source=host.kind==="ssh"?sshSourceFs(host):localSourceFs(host);
      return json(await launchHandoff(control,idOf(handoff[1]!),{confirmed:true,source}));
    }
    if (request.method === "POST" && path === "/api/mgmt/scan") { const cfg = loadManageConfig(options.overloadHome); const result = await scanOnce(control, null, cfg); return json(result); }
    return json({ error: "not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof ControlError) { const cause = (error as any).cause || error.message; const status = error.code === "conflict" ? 409 : error.code === "invalid" ? 400 : error.code === "not_found" ? 404 : 500; return json({ error: cause,
          ...((error as any).data && typeof (error as any).data === "object"
            ? (error as any).data
            : {}),
          allowed: (error as any).allowed, evidence: (error as any).evidence }, { status }); }
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  } finally { control.close(); }
}
