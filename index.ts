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
              ? ` assets=${(data.assetIds as string[]).map(short).join(",")}`
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
      const c = await rpc<any>(
        "moodboard:createConnector", p.from, p.to, p.sourceHandle ?? null, p.targetHandle ?? null,
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
    }),
    async execute(_id, p) {
      const board = await rpc<any>("moodboard:list");
      const item = (board?.items || []).find((i: any) => i.id === p.itemId);
      if (!item) throw new Error(`Aucun item ${p.itemId} — ids via graph_list_nodes.`);
      const data = JSON.parse(JSON.stringify(item.data || {}));
      if (p.params && data.core) data.core.params = { ...(data.core.params || {}), ...p.params };
      if (p.promptText !== undefined) data.promptText = p.promptText;
      const patch: Record<string, unknown> = { data };
      if (p.x !== undefined) patch.x = p.x;
      if (p.y !== undefined) patch.y = p.y;
      const updated = await rpc<any>("moodboard:updateItem", p.itemId, patch);
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
        await rpc("moodboard:deleteItem", p.itemId);
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
      "Lance le rendu d'un node/fenêtre du canvas (même bouton que Run dans l'UI). " +
      "Le rendu démarre côté serveur ; suivre via graph_list_nodes (historique des takes).",
    parameters: Type.Object({
      itemId: Type.String({ description: "id du node Core à rendre" }),
    }),
    async execute(_id, p) {
      await rpc("generation:runWorkflow", p.itemId);
      return ok(`Rendu lancé pour ${p.itemId}.`);
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
