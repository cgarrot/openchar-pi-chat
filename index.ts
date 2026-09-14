/**
 * Pi extension « openchar » — donne à une session Pi le contrôle du canvas OpenChar Studio.
 *
 * Chaque outil appelle le serveur Inline Core (http://127.0.0.1:8848 par défaut, override via
 * INLINE_CORE_URL) sur son canal RPC existant — la même source de vérité que l'UI web.
 * Réglage : OPENCHAR_URL ou INLINE_CORE_URL dans l'environnement du process pi.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CORE_URL = (
  process.env.INLINE_CORE_URL || process.env.OPENCHAR_URL || "http://127.0.0.1:8848"
).replace(/\/$/, "");

// --- NanoGPT catalogs (detailed: per-model parameter schemas) ----------------------------------
const NANOGPT_BASE = (process.env.NANOGPT_API_BASE || "https://nano-gpt.com/api").replace(/\/$/, "");
const NANOGPT_CATALOGS: Record<string, string> = {
  image: "/v1/images/models?detailed=true",
  text: "/v1/models?detailed=true",
  video: "/v1/video-models?detailed=true",
  audio: "/v1/audio-models?detailed=true",
};
const CACHE_FILE = path.join(os.tmpdir(), "openchar-nanogpt-catalogs.json");
const CACHE_TTL = 12 * 3600 * 1000;

function nanogptKey(): string | null {
  const env = (process.env.NANOGPT_API_KEY || "").trim();
  if (env) return env;
  try {
    const key = fs.readFileSync(path.join(os.homedir(), ".config/nano-gpt/api_key"), "utf8").trim();
    return key || null;
  } catch {
    return null;
  }
}

interface CatalogEntry {
  id: string
  name?: string
  description?: string
  architecture?: Record<string, unknown>
  capabilities?: Record<string, unknown>
  supported_parameters?: Record<string, unknown>
  pricing?: Record<string, unknown>
  tags?: string[]
  category?: string
}

async function nanogptCatalog(kind: string): Promise<CatalogEntry[]> {
  let cache: { fetchedAt?: number; catalogs?: Record<string, CatalogEntry[]> } = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch { /* cold */ }
  const fresh = cache.fetchedAt && Date.now() - cache.fetchedAt < CACHE_TTL;
  if (fresh && cache.catalogs?.[kind]) return cache.catalogs[kind];
  const key = nanogptKey();
  if (!key) return cache.catalogs?.[kind] ?? [];
  const res = await fetch(NANOGPT_BASE + NANOGPT_CATALOGS[kind], {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`NanoGPT ${kind} catalog HTTP ${res.status}`);
  const body = (await res.json()) as { data?: CatalogEntry[] } | CatalogEntry[];
  const entries = Array.isArray(body) ? body : body.data ?? [];
  cache = { fetchedAt: Date.now(), catalogs: { ...(cache.catalogs ?? {}), [kind]: entries } };
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch { /* best effort */ }
  return entries;
}

async function rpc<T = any>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await fetch(`${CORE_URL}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent": "openchar-pi" },
    body: JSON.stringify({ channel, args }),
  });
  if (!res.ok) throw new Error(`Core HTTP ${res.status} on ${channel}`);
  const body = (await res.json()) as { ok: boolean; value?: T; error?: unknown };
  if (!body.ok) throw new Error(`Core channel ${channel} failed: ${JSON.stringify(body.error)}`);
  audit(channel, args);
  return body.value as T;
}

/** One JSONL line per agent action, so what the agent did is always reviewable. */
function audit(channel: string, args: unknown[]): void {
  if (!/^(moodboard:(add|update|delete|replace|create)|generation:(run|cancel))/.test(channel)) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), channel, args }) + "\n";
    fs.appendFileSync(AUDIT_FILE, line);
  } catch { /* never fail an action over the audit */ }
}

const AUDIT_FILE = path.join(os.homedir(), ".pi", "openchar-audit.jsonl");

/** Resolve an item id: exact match, or a unique prefix (the compact list shows 8 chars). */
async function resolveItemId(prefix: string): Promise<string> {
  const board = await rpc<any>("moodboard:list");
  const items: any[] = board?.items || [];
  const id = String(prefix).trim();
  const exact = items.find((i) => i.id === id);
  if (exact) return exact.id;
  const matches = items.filter((i) => String(i.id).startsWith(id));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new Error(`Préfixe ambigu (${matches.length} items) — donne plus de caractères.`);
  }
  throw new Error(`Item ${id} introuvable — ids via graph_list_nodes.`);
}

let coreOutputsCache: Record<string, string> | null = null;
let coreInputsCache: Record<string, Array<{ id: string; kind: string }>> | null = null;

/** A core node's declared input ports (for handle auto-fill). */
async function coreInputs(coreType: string): Promise<Array<{ id: string; kind: string }>> {
  if (!coreInputsCache) {
    const models = await rpc<any>("core:models");
    coreInputsCache = {};
    for (const m of models?.models || []) {
      coreInputsCache[m.type] = (m.inputs || []).map((i: any) => ({ id: i.id, kind: i.kind }));
    }
  }
  return coreInputsCache[coreType] ?? [];
}

/** A core item's first output port id — connectors MUST carry it as sourceHandle, or the
 * workflow builder names an output that does not exist and the wire resolves to nothing. */
async function defaultSourceHandle(fromId: string): Promise<string | null> {
  const board = await rpc<any>("moodboard:list");
  const source = (board?.items || []).find((i: any) => i.id === fromId);
  if (!source || source.type !== "core") return null; // prompts/assets are handled by the builder
  if (!coreOutputsCache) {
    const models = await rpc<any>("core:models");
    coreOutputsCache = {};
    for (const m of models?.models || []) {
      const out = (m.outputs || [])[0];
      if (out?.id) coreOutputsCache[m.type] = out.id;
    }
  }
  const coreType = source?.data?.core?.type;
  return (coreType && coreOutputsCache[coreType]) || null;
}

const ok = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: {},
});

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // RPC mode has no TUI: notify would only emit an unanswered UI request.
    if (ctx.mode === "tui") {
      try {
        await rpc("core:status");
        ctx.ui.notify(`openchar: connecté à ${CORE_URL}`, "info");
      } catch {
        ctx.ui.notify(`openchar: Core injoignable sur ${CORE_URL}`, "warning");
      }
    }
  });

  // --- contexte NanoGPT -----------------------------------------------------------------------
  pi.registerTool({
    name: "nanogpt_model_docs",
    label: "NanoGPT: model docs",
    description:
      "La fiche complète d'un modèle NanoGPT : description, modalités (text->video, image+audio->video...), " +
      "le schéma EXACT de ses paramètres (duration, mode, reference_images, lora_url, seed, start/end frame... " +
      "avec valeurs par défaut et options permises) et le prix. À appeler AVANT de régler un node nanogpt/* " +
      "ou quand l'utilisateur parle d'un modèle précis — les params vont dans Extra JSON du node.",
    parameters: Type.Object({
      model: Type.String({ description: "id exact du modèle (ex: minimax-h3, krea-2/turbo)" }),
    }),
    async execute(_id, params) {
      for (const kind of Object.keys(NANOGPT_CATALOGS)) {
        const entries = await nanogptCatalog(kind);
        const hit = entries.find((e) => e.id === params.model);
        if (hit) {
          return ok(
            `Catalogue: ${kind}\n${JSON.stringify(hit, null, 1).slice(0, 12000)}`,
          );
        }
      }
      return ok(
        `Modèle « ${params.model} » introuvable. Liste les ids avec nanogpt_list_models.`,
      );
    },
  });

  pi.registerTool({
    name: "nanogpt_list_models",
    label: "NanoGPT: list models",
    description:
      "Les modèles NanoGPT d'une modalité (image, text, video, audio) avec leur nom. " +
      "Sert à retrouver l'id exact avant nanogpt_model_docs ou la création d'un node.",
    parameters: Type.Object({
      modality: Type.String({ description: "image | text | video | audio" }),
    }),
    async execute(_id, params) {
      const kind = ["image", "text", "video", "audio"].includes(params.modality)
        ? params.modality
        : "image";
      const entries = await nanogptCatalog(kind);
      const lines = entries.map((e) => `${e.id} — ${e.name ?? ""}`).join("\n");
      return ok(`${entries.length} modèles ${kind}:\n${lines}`);
    },
  });

  // --- A4: routing capability -> modele (registry du KB x catalogue live) -------------------------
  pi.registerTool({
    name: "nanogpt_pick_model",
    label: "NanoGPT: pick model",
    description:
      "Routage par CAPABILITY (pas par nom de modèle) : croise le capability registry du KB " +
      "ai-film-knowledge (daté, corroboré — jamais de routage codé en dur) avec le catalogue " +
      "NanoGPT live (disponibilité, prix, params). Ex: 'identity lock image-to-video', " +
      "'precise camera motion', 'text on screen'. Renvoie les lignes du registry qui matchent + " +
      "les modèles NanoGPT correspondants avec leur fiche courte.",
    parameters: Type.Object({
      capability: Type.String({ description: "Besoin en langage libre (ex: 'physics heavy motion')" }),
      modality: Type.Optional(
        Type.String({ description: "image | video — limite la recherche catalogue" }),
      ),
    }),
    async execute(_id, p) {
      const kb = process.env.AIFILM_KB || "/home/cgarrot/zob/ai-film-knowledge";
      const registry = await fsp.readFile(`${kb}/models/capability-registry.md`, "utf8");
      // lignes du tableau registry matchant la capability (insensible cas/sep)
      const want = p.capability.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 3);
      const rows = registry
        .split("\n")
        .filter((l) => l.startsWith("| \\`"))
        .filter((l) => {
          const low = l.toLowerCase();
          return want.some((w) => low.includes(w));
        });
      // modeles mentionnes -> verif presence + prix dans le catalogue
      const mentioned = [...new Set(rows.flatMap((r) => r.split("|")[2]?.match(/[A-Za-z0-9.\- ]{3,}/g) ?? []))];
      const modality = p.modality === "image" ? "image" : p.modality === "video" ? "video" : null;
      const hits: string[] = [];
      for (const kind of modality ? [modality] : ["image", "video"]) {
        const entries = await nanogptCatalog(kind);
        for (const e of entries) {
          const id = String(e.id).toLowerCase();
          const tokens = mentioned
          .map((m) => m.toLowerCase().split(/[^a-z0-9.]/)[0])
          .filter((t) => t.length >= 4);
        if (tokens.some((t) => id.includes(t))) {
            const price =
              (e.pricing as any)?.per_image?.auto ?? (e.pricing as any)?.per_second ??
              (e.pricing as any)?.minimum ?? "?";
            hits.push(
              `${e.id} [${kind}] ${String((e as any).name ?? "")} — prix indicatif: ${price}`,
            );
          }
        }
      }
      return ok(
        (rows.length
          ? `Registry (${rows.length} lignes matchantes, datées + corroborées):\n${rows.join("\n")}`
          : "Aucune ligne du registry ne matche — routing libre, appuie-toi sur le catalogue:") +
          (hits.length ? `\n\nDisponibles sur NanoGPT:\n${[...new Set(hits)].slice(0, 10).join("\n")}` : "") +
          "\n\n(Règle registry: re-vérifier la fiche modèle avant production.)",
      );
    },
  });

  // --- A8: alimentation automatique de l'EVIDENCE-LEDGER ------------------------------------------
  pi.registerTool({
    name: "ledger_record",
    label: "KB: ledger record",
    description:
      "Enregistre un run dans l'EVIDENCE-LEDGER du KB ai-film-knowledge : chaque pipeline " +
      "exécutée sur OpenChar (pattern mobilisé, modèle, outcome PASS/FAIL, QC) doit incrémenter " +
      "la base — elle apprend de NOS runs, pas seulement des cases X. À appeler après chaque " +
      "gate ou batch significatif.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Pattern mobilisé (ex: carrier-assets, delta-editing)" }),
      model: Type.String({ description: "Modèle utilisé (id NanoGPT)" }),
      outcome: Type.String({ description: "PASS | FAIL | PARTIAL + une phrase (QC, coût...)" }),
    }),
    async execute(_id, p) {
      const kb = process.env.AIFILM_KB || "/home/cgarrot/zob/ai-film-knowledge";
      const path = `${kb}/EVIDENCE-LEDGER.md`;
      let project = "";
      try {
        const cur = await rpc<any>("project:current");
        project = cur?.name ?? "";
      } catch {
        /* sans projet ouvert */
      }
      const today = new Date().toISOString().slice(0, 10);
      const line = `- ${today} | ${p.pattern} | ${p.model} | ${p.outcome} | openchar:${project || "?"}\n`;
      let file = await fsp.readFile(path, "utf8");
      const section = "## Runs OpenChar (auto)";
      if (!file.includes(section)) file += `\n${section}\n\n`;
      await fsp.writeFile(path, file.endsWith("\n") ? file + line : file + "\n" + line);
      return ok(`Ledger mis à jour : ${line.trim()}`);
    },
  });

  // --- epinglage de take (gate de validation) ----------------------------------------------------
  pi.registerTool({
    name: "graph_pin_take",
    label: "Graph: pin take",
    description:
      "Épingle UN take précis comme sortie officielle de la node : les nodes aval le " +
      "consomment, et la node épinglée NE SE RE-REND JAMAIS (même si on la relance) — c'est la " +
      "gate de validation « un étage validé ne se re-rend jamais ». Prends les takeId via " +
      "graph_item_info (outputs[].takeId).",
    parameters: Type.Object({
      itemId: Type.String({ description: "id (ou préfixe) de la node" }),
      takeId: Type.String({ description: "takeId à épingler" }),
    }),
    async execute(_id, p) {
      const itemId = await resolveItemId(p.itemId);
      const board = await rpc<any>("moodboard:list");
      const item = (board?.items || []).find((i: any) => i.id === itemId);
      const outputs = item?.data?.core?.outputs || [];
      if (!outputs.some((o: any) => o.takeId === p.takeId)) {
        throw new Error(`takeId ${p.takeId} introuvable sur la node — ids via graph_item_info.`);
      }
      const updated = await rpc<any>("moodboard:updateItem", itemId, {
        data: { ...item.data, core: { ...item.data.core, pinnedTakeId: p.takeId } },
      });
      return ok(`Take ${p.takeId} épinglé sur ${p.itemId}: la node est validée et ne se re-rend plus.`);
    },
  });

  pi.registerTool({
    name: "graph_unpin_take",
    label: "Graph: unpin take",
    description:
      "Retire l'épinglage : la node redevient re-renderable et son dernier take redevient la sortie.",
    parameters: Type.Object({ itemId: Type.String({}) }),
    async execute(_id, p) {
      const itemId = await resolveItemId(p.itemId);
      const board = await rpc<any>("moodboard:list");
      const item = (board?.items || []).find((i: any) => i.id === itemId);
      if (!item?.data?.core) throw new Error(`Node ${p.itemId} introuvable.`);
      const updated = await rpc<any>("moodboard:updateItem", itemId, {
        data: { ...item.data, core: { ...item.data.core, pinnedTakeId: null } },
      });
      return ok(`Épinglage retiré de ${p.itemId}.`);
    },
  });

  // --- QC vision sur un take ----------------------------------------------------------------------
  /** The canonical QC grids from the ai-film-knowledge repo (python3+PyYAML available). */
  async function qcGrid(grid: string): Promise<string> {
    const kb = process.env.AIFILM_KB || "/home/cgarrot/zob/ai-film-knowledge";
    const { execFile } = await import("node:child_process");
    const json = await new Promise<string>((resolve, reject) => {
      execFile(
        "python3",
        [
          "-c",
          "import json,yaml,sys;d=yaml.safe_load(open(sys.argv[1]))['dimensions'].get(sys.argv[2]);" +
            "print(json.dumps(d if d else None))",
          `${kb}/tools/qc_checklists.yaml`,
          grid,
        ],
        { timeout: 15000 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
    const dim = JSON.parse(json || "null");
    if (!dim) throw new Error(`Grille QC « ${grid} » introuvable (identity|motion|continuity|cinematic_quality).`);
    const checks = (dim.checks || []) as Array<{ id?: string; q?: string; fail_if?: string }>;
    return (
      `[Grille canonique ${grid} — ${kb}]\n` +
      checks.map((c) => `${c.id ?? "?"}: ${c.q ?? ""} (FAIL si: ${c.fail_if ?? "?"})`).join("\n")
    );
  }

  pi.registerTool({
    name: "take_qc",
    label: "Take: QC vision",
    description:
      "Analyse une image du canvas (take d'une node, ou chemin de fichier) avec un modèle vision " +
      "NanoGPT. Deux modes : grid= (grilles CANONIQUES du KB ai-film — identity, motion, " +
      "continuity, cinematic_quality) ou checklist= (points libres). Sert aux gates G0 (masters), " +
      "G1 (keyframes), G4 (premières frames vidéo). Renvoie PASS/FAIL point par point + verdict.",
    parameters: Type.Object({
      path: Type.String({ description: "Chemin du fichier image (ou via graph_export_clips)" }),
      grid: Type.Optional(
        Type.String({ description: "Grille canonique : identity | motion | continuity | cinematic_quality" }),
      ),
      checklist: Type.Optional(Type.String({ description: "Checklist libre (une ligne par point), si pas de grid" })),
    }),
    async execute(_id, p) {
      const checklist = p.grid
        ? await qcGrid(p.grid)
        : (p.checklist ?? "").trim() || "(conformité générale à la référence)";
      const fs2 = await import("node:fs/promises");
      const os2 = await import("node:os");
      let imgPath = p.path.replace(/^file:\/\//, "");
      let mime = "image/png";
      // A 6 MB take PNG is an HTTP 413 at the vision endpoint: pre-shrink like the
      // agent had to do by hand (ffmpeg scale → quality JPEG).
      const stat = await fs2.stat(imgPath);
      if (stat.size > 900_000) {
        const tmp = `${os2.tmpdir()}/takeqc-${Date.now()}.jpg`;
        const { execFile } = await import("node:child_process");
        await new Promise<void>((resolve, reject) => {
          execFile(
            "ffmpeg",
            ["-y", "-i", imgPath, "-vf", "scale='min(1536,iw)':-2", "-q:v", "5", tmp],
            { timeout: 30000 },
            (err) => (err ? reject(err) : resolve()),
          );
        }).catch(() => null); // best effort: on failure, send the original
        try {
          await fs2.access(tmp);
          imgPath = tmp;
          mime = "image/jpeg";
        } catch {
          /* garde l'original */
        }
      }
      const data = await fs2.readFile(imgPath);
      const b64 = data.toString("base64");
      const key = nanogptKey();
      if (!key) return ok("Pas de clé NanoGPT — QC vision indisponible.");
      // modèle vision : premier du catalogue texte détaillé acceptant des images en entrée
      let model = process.env.NANOGPT_VISION_MODEL || "";
      if (!model) {
        const entries = await nanogptCatalog("text");
        const withImage = entries.filter(
          (e: any) => (e?.architecture?.input_modalities || []).includes("image"),
        );
        // Prefer a real vision-chat model over OCR/describer backends (LightOnOCR once
        // auto-picked itself and answered with a scene description instead of the grid).
        const prefer = [/^openai\//, /^google\//, /^anthropic\//, /(qwen|pixtral|llama)/i];
        let chatLike: any;
        for (const rx of prefer) {
          chatLike = withImage.find((e: any) => rx.test(String(e.id)));
          if (chatLike) break;
        }
        model = chatLike?.id || withImage[0]?.id || "openai/gpt-5.6-sol";
      }
      const res = await fetch(NANOGPT_BASE + "/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 900,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    "Tu es responsable qualité image d'un studio d'animation. Vérifie CHAQUE point " +
                    "de la checklist contre l'image. Réponds point par point : PASS/FAIL + une " +
                    "phrase de détail. Termine par un verdict GLOBAL PASS ou FAIL.\n\nChecklist:\n" +
                    checklist,
                },
                { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
              ],
            },
          ],
        }),
      });
      if (!res.ok) return ok(`QC vision HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as any;
      const content = body?.choices?.[0]?.message?.content;
      const text = Array.isArray(content)
        ? content.map((b: any) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('\n')
        : String(content ?? '');
      if (!text.trim()) {
        return ok(
          `[QC vision — ${model}] réponse vide. Corps: ${JSON.stringify(body).slice(0, 400)}`,
        );
      }
      return ok(`[QC vision — ${model}]\n${text}`);
    },
  });

  // --- export CLIPS pour le montage ----------------------------------------------------------------
  pi.registerTool({
    name: "graph_export_clips",
    label: "Graph: export CLIPS",
    description:
      "Exporte les takes actifs du board en tableau shell CLIPS=(...) prêt à coller dans " +
      "build_minute01.sh : une entrée par node génératrice (take épinglé sinon le dernier), " +
      "triées par position canvas (gauche→droite, haut→bas).",
    parameters: Type.Object({}),
    async execute() {
      const board = await rpc<any>("moodboard:list");
      const items = (board?.items || [])
        .filter((i: any) => i?.data?.core)
        .map((i: any) => {
          const outputs = i.data.core.outputs || [];
          const pinned = i.data.core.pinnedTakeId;
          const take =
            outputs.find((o: any) => o.takeId === pinned) || outputs[0] || null;
          return take ? { x: i.x, y: i.y, path: take.filePath, id: i.id } : null;
        })
        .filter(Boolean)
        .sort((a: any, b: any) => a.x - b.x || a.y - b.y);
      const base = process.env.OPENCHAR_PROJECT_DIR || "";
      const lines = items.map(
        (t: any) => `  "${base ? base + "/" : ""}${t.path}"  # ${t.id.slice(0, 8)}`,
      );
      return ok(`CLIPS=(
${lines.join("\n")}
)`);
    },
  });

  // --- auto-nommage de l'onglet ----------------------------------------------------------------
  pi.registerTool({
    name: "chat_set_title",
    label: "Chat: set title",
    description:
      "Nomme l'onglet de chat courant (2-4 mots simples et logiques décrivant le sujet de la " +
      "conversation, dans la langue de l'utilisateur). À appeler une seule fois, juste après la " +
      "première réponse utile.",
    parameters: Type.Object({
      title: Type.String({ description: "Titre court, ex: 'Génération phare tempête'" }),
    }),
    async execute(_id, params) {
      const tabId = process.env.INLINE_CHAT_TAB_ID;
      if (!tabId) return ok("(pas d'onglet associé — ignoré)");
      const tab = await rpc<any>("chat:renameTab", tabId, String(params.title).slice(0, 60), true);
      return ok(`Onglet renommé : ${tab?.title ?? params.title}`);
    },
  });

  // --- lecture ------------------------------------------------------------------------------
  pi.registerTool({
    name: "graph_list_nodes",
    label: "Graph: list",
    description:
      "The canvas in compact form: one line per item (short id, type, core type, position, key " +
      "params) plus the connectors. This answers most questions — pass full: true only when you " +
      "need the raw board JSON.",
    parameters: Type.Object({
      full: Type.Optional(Type.Boolean({ description: "Raw board JSON instead of the summary" })),
    }),
    async execute(_id, params) {
      const board = await rpc<any>("moodboard:list");
      const items: any[] = board?.items || [];
      const connectors: any[] = board?.connectors || [];
      const short = (id: string): string => String(id).slice(0, 8);
      const lines = items.map((i: any) => {
        const data = i.data || {};
        const core = data.core || {};
        const params = core.params || {};
        const brief = Object.entries(params)
          .filter(([, v]) => v !== "" && v != null && v !== -1 && v !== "auto")
          .slice(0, 3)
          .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
          .join(" ");
        const extra =
          i.type === "prompt" && data.promptText
            ? ` text=${String(data.promptText).slice(0, 60)}`
            : Array.isArray(data.assetIds) && data.assetIds.length
              ? `${data.name ? ` "${String(data.name)}"` : ""} assets=${(data.assetIds as string[]).map(short).join(",")}`
              : data.name
                ? ` "${String(data.name)}"`
                : "";
        return `${short(i.id)} ${core.type ?? i.type} @(${Math.round(i.x)},${Math.round(i.y)})${
          brief ? ` ${brief}` : ""
        }${extra}`;
      });
      const links = connectors.map(
        (c: any) => `${short(c.fromItemId)} -> ${short(c.toItemId)}`,
      );
      if (params.full) {
        return ok(JSON.stringify(board, null, 1).slice(0, 12000));
      }
      return ok(
        `${items.length} items:\n${lines.join("\n")}\n${links.length ? `connectors:\n${links.join("\n")}` : "(no connectors)"}`,
      );
    },
  });

  pi.registerTool({
    name: "graph_list_node_types",
    label: "Graph: node types",
    description:
      "Les types de nodes Core disponibles (générateurs, loaders, contrôle…) avec leurs ports " +
      "et params — à appeler avant de créer un node pour connaître son type exact.",
    parameters: Type.Object({}),
    async execute() {
      const models = await rpc<any>("core:models");
      const lines = (models?.models || [])
        .map((m: any) => `${m.type} — ${m.title} [${m.category}] in:${(m.inputs || []).map((i: any) => i.id).join(",") || "-"} out:${(m.outputs || []).map((o: any) => o.id).join(",") || "-"}`)
        .join("\n");
      return ok(`Node types disponibles:\n${lines}`);
    },
  });

  // --- création ------------------------------------------------------------------------------
  pi.registerTool({
    name: "graph_add_node",
    label: "Graph: add node",
    description:
      "Ajoute un node Core sur le canvas OpenChar (ex: alibaba/z-image-turbo, nanogpt/image, " +
      "input/text). Renvoie l'item créé avec son id.",
    parameters: Type.Object({
      type: Type.String({ description: "Type Core exact du node (voir graph_list_node_types)" }),
      x: Type.Number({ description: "Position X sur le canvas" }),
      y: Type.Number({ description: "Position Y sur le canvas" }),
    }),
    async execute(_id, params) {
      const item = await rpc<any>("moodboard:addCoreNode", params.type, params.x, params.y);
      return ok(`Node créé: ${JSON.stringify(item)}`);
    },
  });

  pi.registerTool({
    name: "graph_add_prompt",
    label: "Graph: add prompt",
    description:
      "Ajoute un item prompt texte sur le canvas. Renvoie l'item créé ; remplir le texte avec " +
      "graph_update_node (patch.promptText).",
    parameters: Type.Object({
      x: Type.Number({}),
      y: Type.Number({}),
    }),
    async execute(_id, params) {
      const item = await rpc<any>("moodboard:addPrompt", params.x, params.y);
      return ok(`Prompt créé: ${JSON.stringify(item)}`);
    },
  });

  pi.registerTool({
    name: "graph_connect",
    label: "Graph: connect",
    description:
      "Câble deux items du canvas (crée un connecteur). Les ids viennent de graph_list_nodes ; " +
      "les handles optionnels nomment les ports précis (ex: 'prompt', 'image').",
    parameters: Type.Object({
      from: Type.String({ description: "id de l'item source (ex: un prompt)" }),
      to: Type.String({ description: "id de l'item cible (ex: un node de génération)" }),
      sourceHandle: Type.Optional(Type.String({})),
      targetHandle: Type.Optional(Type.String({})),
    }),
    async execute(_id, p) {
      const from = await resolveItemId(p.from);
      const to = await resolveItemId(p.to);
      // Auto-fill the source handle for core sources: without it the builder resolves the wire
      // to a non-existent output and downstream nodes see zero inputs.
      const sourceHandle = p.sourceHandle ?? (await defaultSourceHandle(from));
      // Auto-fill the target handle too: a core target with exactly one text input (the usual
      // prompt→generator wire) should not need an explicit handle — a missing one once sent
      // six runs to a non-existent "in" port before the agent noticed.
      let targetHandle = p.targetHandle ?? null;
      const board = await rpc<any>("moodboard:list");
      const toItem = (board?.items || []).find((i: any) => i.id === to);
      const toCore = toItem?.data?.core?.type;
      if (!targetHandle && toCore) {
        const textPorts = (await coreInputs(toCore)).filter((port) => port.kind === "text");
        if (textPorts.length === 1) targetHandle = textPorts[0].id;
      }
      const c = await rpc<any>(
        "moodboard:createConnector", from, to, sourceHandle, targetHandle,
      );
      return ok(`Connecteur créé: ${JSON.stringify(c)}`);
    },
  });

  // --- modification ---------------------------------------------------------------------------
  pi.registerTool({
    name: "graph_update_node",
    label: "Graph: update",
    description:
      "Met à jour un item : position (x, y), taille, ou data. Pour un node Core: " +
      "data.core.params (ex: {prompt: '...'} fusionne les params du node). Pour un item prompt: " +
      "data.promptText. Le merge est fait côté extension — pas besoin de renvoyer tout l'objet.",
    parameters: Type.Object({
      itemId: Type.String({}),
      x: Type.Optional(Type.Number({})),
      y: Type.Optional(Type.Number({})),
      params: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "params à fusionner dans data.core.params" })),
      promptText: Type.Optional(Type.String({ description: "texte d'un item prompt" })),
      name: Type.Optional(Type.String({ description: "nom lisible de l'item (ex: 'Master Rue', 'Sheet Mathieu') — affiché sur la node et dans les listings" })),
    }),
    async execute(_id, p) {
      const itemId = await resolveItemId(p.itemId);
      const board = await rpc<any>("moodboard:list");
      const item = (board?.items || []).find((i: any) => i.id === itemId);
      if (!item) throw new Error(`Aucun item ${p.itemId} — ids via graph_list_nodes.`);
      const data = JSON.parse(JSON.stringify(item.data || {}));
      if (p.params && data.core) data.core.params = { ...(data.core.params || {}), ...p.params };
      if (p.promptText !== undefined) data.promptText = p.promptText;
      if (p.name !== undefined && p.name !== "") data.name = String(p.name);
      const patch: Record<string, unknown> = { data };
      if (p.x !== undefined) patch.x = p.x;
      if (p.y !== undefined) patch.y = p.y;
      const updated = await rpc<any>("moodboard:updateItem", itemId, patch);
      return ok(`Item mis à jour: ${JSON.stringify(updated).slice(0, 800)}`);
    },
  });

  pi.registerTool({
    name: "graph_delete",
    label: "Graph: delete",
    description: "Supprime un item (node/prompt) ou un connecteur du canvas.",
    parameters: Type.Object({
      itemId: Type.Optional(Type.String({})),
      connectorId: Type.Optional(Type.String({})),
    }),
    async execute(_id, p) {
      if (p.connectorId) {
        await rpc("moodboard:deleteConnector", p.connectorId);
        return ok(`Connecteur ${p.connectorId} supprimé.`);
      }
      if (p.itemId) {
        const itemId = await resolveItemId(p.itemId);
        await rpc("moodboard:deleteItem", itemId);
        return ok(`Item ${p.itemId} supprimé.`);
      }
      throw new Error("itemId ou connectorId requis.");
    },
  });

  // --- exécution -------------------------------------------------------------------------------
  pi.registerTool({
    name: "graph_run",
    label: "Graph: run",
    description:
      "Lance le rendu d'un node. Le moteur exécute TOUTE sa chaîne amont dans l'ordre (études → " +
      "fusion → vues), avec cache des nodes déjà rendus — donc lance le node FINAL pour dérouler " +
      "la pipeline entière. Avec wait=true (défaut), attend que le rendu produise son take " +
      "(jusqu'à timeout s) et renvoie les takes obtenus.",
    parameters: Type.Object({
      itemId: Type.String({ description: "id du node Core à rendre" }),
      wait: Type.Optional(Type.Boolean({ description: "Attendre la fin du rendu (défaut true)" })),
      timeout: Type.Optional(Type.Number({ description: "Attente max en secondes (défaut 600)" })),
    }),
    async execute(_id, p, signal) {
      const outputsOf = (item: any): any[] =>
        ((item?.data?.core?.outputs as any[]) ?? []).filter((o) => o && o.takeId);
      const itemId = await resolveItemId(p.itemId);
      const before = await rpc<any>("moodboard:list");
      const target = (before?.items || []).find((i: any) => i.id === itemId);
      if (!target) throw new Error(`Item ${p.itemId} introuvable.`);
      const had = outputsOf(target).length;
      await rpc("generation:runWorkflow", itemId);
      if (p.wait === false) return ok(`Rendu lancé pour ${itemId}.`);
      const deadline = Date.now() + (p.timeout ?? 600) * 1000;
      while (Date.now() < deadline) {
        // Abort-responsive: the user's Stop must interrupt a long wait immediately.
        if (signal?.aborted) return ok(`Attente interrompue pour ${itemId} — le rendu continue côté serveur; re-vérifie avec graph_item_info.`);
        await new Promise((r) => setTimeout(r, 5000));
        if (signal?.aborted) return ok(`Attente interrompue pour ${itemId} — le rendu continue côté serveur.`);
        const board = await rpc<any>("moodboard:list");
        const item = (board?.items || []).find((i: any) => i.id === itemId);
        const takes = outputsOf(item);
        if (takes.length > had) {
          return ok(
            `Rendu terminé pour ${itemId} : ${takes.length} take(s) — plus récent: ${JSON.stringify(takes[0]).slice(0, 300)}`,
          );
        }
        // échec visible ? l'historique d'activité porte les erreurs récentes
        if (takes.length === had) {
          try {
            const history = await rpc<any[]>("activity:history", 6);
            const failed = (Array.isArray(history) ? history : []).find(
              (a: any) => (a?.itemId === itemId || a?.itemId?.startsWith?.(String(itemId).slice(0, 8))) && /error|fail/i.test(String(a?.status ?? a?.result ?? "")),
            );
            if (failed) {
              return ok(
                `ÉCHEC du rendu ${itemId} : ${JSON.stringify(failed).slice(0, 400)} — corrige (graph_update_node) puis relance.`,
              );
            }
          } catch { /* activity optionnel */ }
        }
      }
      return ok(
        `Le rendu de ${itemId} tourne toujours après ${p.timeout ?? 600}s (takes: ${had}). ` +
          `Re-vérifie avec graph_item_info.`,
      );
    },
  });

  pi.registerTool({
    name: "graph_item_info",
    label: "Graph: item info",
    description:
      "La fiche complète d'un item : type, params, prompt, connecteurs attachés et historique " +
      "des takes produits (outputs). Sert à vérifier qu'un rendu a bien abouti.",
    parameters: Type.Object({
      itemId: Type.String({}),
    }),
    async execute(_id, p) {
      const itemId = await resolveItemId(p.itemId);
      const board = await rpc<any>("moodboard:list");
      const item = (board?.items || []).find((i: any) => i.id === itemId);
      if (!item) throw new Error(`Item ${p.itemId} introuvable.`);
      const conns = (board?.connectors || []).filter(
        (c: any) => c.fromItemId === itemId || c.toItemId === itemId,
      );
      return ok(JSON.stringify({ item, connectors: conns }, null, 1).slice(0, 8000));
    },
  });

  pi.registerTool({
    name: "activity_recent",
    label: "Activity: recent",
    description:
      "Les runs récents (générations, entraînements) avec leur statut — la première chose à " +
      "consulter quand un rendu échoue ou n'aboutit pas.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Nb d'entrées (défaut 10)" })),
    }),
    async execute(_id, p) {
      const history = await rpc<any[]>("activity:history", p.limit ?? 10);
      return ok(JSON.stringify(history, null, 1).slice(0, 6000));
    },
  });

  pi.registerTool({
    name: "graph_cancel",
    label: "Graph: cancel",
    description: "Annule le rendu en cours d'un node (ou de tous si itemId omis).",
    parameters: Type.Object({
      itemId: Type.Optional(Type.String({})),
    }),
    async execute(_id, p) {
      await rpc("generation:cancel", p.itemId ?? null);
      return ok("Annulation envoyée.");
    },
  });

  // --- contexte projet ------------------------------------------------------------------------
  pi.registerTool({
    name: "project_info",
    label: "Project info",
    description: "Projet OpenChar courant (nom, dossier) + la liste des fenêtres/frames.",
    parameters: Type.Object({}),
    async execute() {
      const current = await rpc<any>("project:current");
      let frames: unknown;
      try {
        frames = await rpc<any>("frames:list");
      } catch {
        frames = "aucun projet ouvert";
      }
      return ok(`Projet: ${JSON.stringify(current)}\nFrames: ${JSON.stringify(frames).slice(0, 2000)}`);
    },
  });
}
