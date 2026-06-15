/**
 * sotc.js — System Entry Point
 *
 * An adaptation of Atropos' simple and flexible system that makes it less simple and hopefully still flexible.
 * Author: Tsubasa
 *
 * This file is intentionally slim. It wires up Foundry's document/sheet
 * registrations, game settings, Handlebars helpers, and the GM actor-update
 * relay. All heavy lifting lives in:
 *
 *   combat.js  — combat lifecycle, status sync, item/token hooks
 *   damage.js  — damage wizard, chat hooks, token trackers
 */

// ── Module imports ────────────────────────────────────────────────────────────
import { SotCActor }                          from "./actor.js";
import { SotCItem }                           from "./item.js";
import { SotCActorSheet }                     from "./actor-sheet.js";
import { SotCSkillSheet }                     from "./skill-sheet.js";
import { SotCStatusSheet }                    from "./status-sheet.js";
import { SotCPassiveSheet }                   from "./passive-sheet.js";
import { SotCToken, SotCTokenDocument }       from "./token.js";
import { preloadHandlebarsTemplates }         from "./templates.js";
import { createSotCMacro }                    from "./macro.js";
import { enrichModWithStatusIcons, KeywordConfigApp } from "./helper.js";

// Side-effect imports — these files register their own hooks on load.
import "./combat.js";
import { _egoPassiveTracker, _enemyRevealTracker } from "./damage.js";

/* -------------------------------------------- */
/*  Foundry VTT Initialization                  */
/* -------------------------------------------- */

Hooks.once("init", async function () {
  console.log("Initializing SotC");

  // Base initiative config (failsafe formula + decimals for tiebreaking)
  CONFIG.Combat.initiative = {
    formula:  "1d6",
    decimals: 2
  };

  // Wire our custom Combat class (defined in combat.js, imported above)
  const { SotCCombat } = await import("./combat.js");
  CONFIG.Combat.documentClass = SotCCombat;

  // ── Document classes ───────────────────────────────────────────────────────
  // SotCTokenDocument and SotCToken are registered but not otherwise modified;
  // if that ever changes this comment should be updated too. Haha.
  CONFIG.Actor.documentClass  = SotCActor;
  CONFIG.Item.documentClass   = SotCItem;
  CONFIG.Token.documentClass  = SotCTokenDocument;
  CONFIG.Token.objectClass    = SotCToken;

  // ── Actor / Item types ─────────────────────────────────────────────────────
  // PLEASE localise this eventually (Russian, Korean, Chinese, Japanese at minimum).
  CONFIG.Actor.types      = ["character"]; // No NPC Yet!!!!!!
  CONFIG.Item.types       = ["skill", "ego", "status", "passive"];
  CONFIG.Actor.typeLabels = { character: "Character" /*, npc: "NPC" */ };
  CONFIG.Item.typeLabels  = { skill: "Skill", ego: "EGO", status: "Status", passive: "Passive" };

  // ── Sheet registrations ────────────────────────────────────────────────────
  Actors.unregisterSheet("core", foundry.appv1.sheets.ActorSheet);
  Actors.registerSheet("sotc", SotCActorSheet, { types: ["character"], makeDefault: true });
  Items.unregisterSheet("core", foundry.appv1.sheets.ItemSheet);
  Items.registerSheet("sotc", SotCSkillSheet,  { types: ["skill", "ego"], makeDefault: true });
  Items.registerSheet("sotc", SotCStatusSheet, { types: ["status"] });
  Items.registerSheet("sotc", SotCPassiveSheet, { types: ["passive"] });

  // ── System settings ────────────────────────────────────────────────────────

  game.settings.register("sotc", "macroShorthand", {
    name:    "SETTINGS.SotCMacroShorthandN",
    hint:    "SETTINGS.SotCMacroShorthandL",
    scope:   "sotc",
    type:    Boolean,
    default: true,
    config:  true
  });

  game.settings.register("sotc", "chatKeywords", {
    name:    "Chat Keyword Icons",
    hint:    "JSON list of custom keyword→icon mappings for chat enrichment.",
    scope:   "world",
    type:    String,
    default: "[]",
    config:  false  // managed via the settings menu button below
  });

  game.settings.register("sotc", "restoreStaggerOnCombatEnd", {
    name:    "Restore Stagger on Combat End",
    hint:    "When combat ends, automatically restore all combatants' stagger to their maximum value.",
    scope:   "world",
    type:    Boolean,
    default: true,
    config:  true
  });

  game.settings.register("sotc", "restoreLightOnCombatEnd", {
    name:    "Restore Light on Combat End",
    hint:    "When combat ends, automatically restore all combatants' light to their maximum value.",
    scope:   "world",
    type:    Boolean,
    default: true,
    config:  true
  });

  game.settings.register("sotc", "playerDamageWizard", {
    name:    "Players Can Apply Damage to Enemies",
    hint:    "When enabled, players can open and resolve the Damage Wizard from their own skill rolls and apply damage directly to enemy tokens. The update is proxied through the GM socket so players never need ownership of the target. When disabled, only the GM can resolve the wizard.",
    scope:   "world",
    type:    Boolean,
    default: false,
    config:  true
  });

  // ── Alternate Rules ────────────────────────────────────────────────────────

  game.settings.register("sotc", "enemyEmotionPoints", {
    name:    "Enemies Gain Emotion Points",
    hint:    "When enabled, enemy (non-player) actors also gain 1 Emotion Point when participating in a clash resolution, the same as player characters.",
    scope:   "world",
    type:    Boolean,
    default: false,
    config:  true
  });

  game.settings.register("sotc", "sinkingEnemyEmotionPoints", {
    name:    "Sinking Also Costs Enemies Emotion Points",
    hint:    "[Alternate Rule] By default, Sinking only reduces Emotion Points on player characters. When enabled, enemy actors also lose EP equal to half their Sinking count when the end-of-scene Sinking effect triggers.",
    scope:   "world",
    type:    Boolean,
    default: false,
    config:  true
  });

  game.settings.register("sotc", "sinkingPlayerEmotionPoints", {
    name:    "Sinking Costs Players Emotion Points",
    hint:    "When enabled (default), Sinking reduces a player character's Emotion Points by half the Sinking count at scene end. Disable to remove the EP cost for players entirely.",
    scope:   "world",
    type:    Boolean,
    default: true,
    config:  true
  });

  game.settings.register("sotc", "emotionPointAutoCalc", {
    name:    "Auto-Calculate Emotion Points on Clash",
    hint:    "When enabled (default), Emotion Points are automatically awarded to qualifying actors after each clash resolution. Disable to manage EP manually.",
    scope:   "world",
    type:    Boolean,
    default: true,
    config:  true
  });

  game.settings.register("sotc", "bleedAutoCalc", {
    name:    "Auto-Calculate Bleed on Hit",
    hint:    "When enabled (default), Bleed damage is automatically applied and reduced when an attacker with Bleed wins or goes unopposed. Disable to manage Bleed manually.",
    scope:   "world",
    type:    Boolean,
    default: true,
    config:  true
  });

  game.settings.register("sotc", "egoPassiveData", {
    name:    "EGO Passive Tracker Data",
    scope:   "world",
    config:  false,
    type:    String,
    default: "{}"
  });

  game.settings.register("sotc", "enemyRevealData", {
    name:    "Enemy Reveal Tracker Data",
    scope:   "world",
    config:  false,
    type:    String,
    default: "{}"
  });

  game.settings.register("sotc", "egoPassiveTrackerEnabled", {
    name:    "Enable EGO Passive Tracker",
    hint:    "Shows a badge on player tokens when EGO passives are active, with a clickable panel to review them.",
    scope:   "world",
    type:    Boolean,
    default: true,
    config:  true
  });

  game.settings.register("sotc", "enemyRevealTrackerEnabled", {
    name:    "Enable Enemy Reveal Tracker",
    hint:    "Automatically tracks enemy skills and passives as they appear in chat, showing them on the enemy token.",
    scope:   "world",
    type:    Boolean,
    default: true,
    config:  true
  });

  // ── Settings UI dividers (Foundry has no native grouping API) ─────────────
  Hooks.on("renderSettingsConfig", (app, html) => {
    const divider = (label, icon, color, borderColor) => `
      <div style="
        grid-column: 1 / -1;
        border-top: 2px solid ${borderColor};
        margin: 14px 0 6px 0;
        padding-top: 8px;
        display: flex;
        align-items: center;
        gap: 8px;
        color: ${color};
        font-family: 'Signika', serif;
        font-size: 13px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      ">
        <i class="${icon}" style="font-size:14px; opacity:0.8;"></i>
        ${label}
      </div>
    `;
    const gmRow  = html.find(`[data-setting-id="sotc.playerDamageWizard"]`).closest(".form-group");
    if (gmRow.length)  gmRow.before(divider("GM Settings",     "fas fa-shield-alt", "#7ab8e0", "#2a5a7a"));
    const altRow = html.find(`[data-setting-id="sotc.enemyEmotionPoints"]`).closest(".form-group");
    if (altRow.length) altRow.before(divider("Alternate Rules", "fas fa-dice-d20",   "#c090e0", "#5a3a6a"));
  });

  // ── Settings menu buttons ──────────────────────────────────────────────────

  // Generate Player Statuses folder
  class GenerateStatusFolderApp extends foundry.appv1.api.FormApplication {
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        title:    "Generate Status Folder",
        template: "templates/hud/waypoint-label.hbs"
      });
    }
    async _render() { await GenerateStatusFolderApp._generate(); }
    static async _generate() {
      const FOLDER_NAME = "Player Statuses";
      let folder = game.folders.find(f => f.name === FOLDER_NAME && f.type === "Item");
      if (!folder) {
        folder = await Folder.create({ name: FOLDER_NAME, type: "Item", color: "#c9a227" });
        ui.notifications.info(`SotC | Created folder "${FOLDER_NAME}" in Items.`);
      } else {
        ui.notifications.info(`SotC | Folder "${FOLDER_NAME}" already exists.`);
      }
      ui.sidebar.activateTab("items");
    }
  }
  game.settings.registerMenu("sotc", "generateStatusFolder", {
    name:       "Generate Player Status Folder",
    label:      "Generate Folder",
    hint:       "Creates a 'Player Statuses' folder in the Items directory for world-level status items that players can apply via macros and chat buttons.",
    icon:       "fas fa-folder-plus",
    type:       GenerateStatusFolderApp,
    restricted: true
  });

  // Chat keyword icon configuration
  game.settings.registerMenu("sotc", "chatKeywordsMenu", {
    name:       "Chat Keyword Icons",
    label:      "Configure Keywords",
    hint:       "Add custom keywords (e.g. [On Use], Clash Win) with icons that appear inline in chat skill messages.",
    icon:       "fas fa-icons",
    type:       KeywordConfigApp,
    restricted: true
  });

  // ── Handlebars helpers ─────────────────────────────────────────────────────

  Handlebars.registerHelper("slugify", function (value) {
    return value.slugify({ strict: true });
  });

  Handlebars.registerHelper({
    eq:  (v1, v2) => v1 === v2,
    ne:  (v1, v2) => v1 !== v2,
    lt:  (v1, v2) => v1 <  v2,
    gt:  (v1, v2) => v1 >  v2,
    lte: (v1, v2) => v1 <= v2,
    gte: (v1, v2) => v1 >= v2,
    and() { return Array.prototype.every.call(arguments, Boolean); },
    or()  { return Array.prototype.slice.call(arguments, 0, -1).some(Boolean); }
  });

  // ── Socket stub (system.sotc) ──────────────────────────────────────────────
  // The socket is registered here so it's ready before any messages arrive.
  // The actual GM relay logic lives in the ready hook below.
  game.socket.on("system.sotc", async (data) => {
    if (!data?.type) return;

    // EGO passive badge sync — update every client's badge immediately
    if (data.type === "egoPassiveSync" && data.actorId) {
      // All clients redraw the badge from the payload
      game.sotc?.egoPassiveTracker?.syncActor(data.actorId, data.entries);
      // Only the GM writes the world setting so data survives F5
      if (game.user.isGM && game.users.activeGM?.isSelf) {
        try {
          let stored = {};
          try { stored = JSON.parse(game.settings.get("sotc", "egoPassiveData") || "{}"); } catch {}
          if (data.entries?.length) stored[data.actorId] = data.entries;
          else delete stored[data.actorId];
          await game.settings.set("sotc", "egoPassiveData", JSON.stringify(stored));
        } catch (e) { console.warn("sotc | egoPassiveSync: could not persist:", e); }
      }
    }

    // Enemy reveal badge sync — fires on all clients when any client adds/removes
    if (data.type === "enemyRevealSync" && data.actorId) {
      game.sotc?.enemyRevealTracker?.syncActor(data.actorId, data.entries);
    }
  });

  // Preload Handlebars template partials
  await preloadHandlebarsTemplates();
});

/* -------------------------------------------- */
/*  Ready hook                                   */
/* -------------------------------------------- */

Hooks.once("ready", () => {
  console.log("SotC | System ready");

  // ── Custom dice sound ──────────────────────────────────────────────────────
  CONFIG.sounds.dice = "systems/sotc/assets/audio/speed_dice.mp3";
  console.log("sotc | Custom dice sound registered ✓");

  // ── game.sotc namespace ────────────────────────────────────────────────────
  // Expose helpers and utilities. Trackers are initialised here, after
  // game.sotc exists, so they can safely reference it.
  game.sotc = {
    SotCActor,
    createSotCMacro,
    enrichModWithStatusIcons,

    // ── End-of-scene debugger ────────────────────────────────────────────────
    // Run in the browser console: game.sotc.debugEndOfScene()
    debugEndOfScene() {
      const lines = ["=== END OF SCENE DEBUG ==="];
      const restoreLight   = game.settings.get("sotc", "restoreLightOnCombatEnd");
      const restoreStagger = game.settings.get("sotc", "restoreStaggerOnCombatEnd");
      const sinkingPlayers = game.settings.get("sotc", "sinkingPlayerEmotionPoints");
      const sinkingEnemies = game.settings.get("sotc", "sinkingEnemyEmotionPoints");
      lines.push(`Settings: restoreLight=${restoreLight}, restoreStagger=${restoreStagger}, sinkingPlayers=${sinkingPlayers}, sinkingEnemies=${sinkingEnemies}`);
      lines.push(`Is GM: ${game.user.isGM}, Is Active GM: ${game.users.activeGM?.isSelf}`);
      if (!game.user.isGM) lines.push("⚠ NOT GM — end-of-scene effects will NOT run for you!");
      if (!game.users.activeGM?.isSelf) lines.push("⚠ You are not the ACTIVE GM — end-of-scene effects will NOT run!");
      const combat = game.combat;
      if (!combat) {
        lines.push("⚠ No active combat — deleteCombat hook fires only when combat is ended via the combat tracker!");
      } else {
        lines.push(`Active combat: round ${combat.round}, ${combat.combatants.size} combatants`);
        for (const c of combat.combatants) {
          const actor = c.actor;
          if (!actor) { lines.push(`  - ${c.name}: ⚠ no actor found`); continue; }
          const lightMax = actor.system.light?.max    ?? 0;
          const lightVal = actor.system.light?.value  ?? 0;
          const stagMax  = actor.system.stagger?.max  ?? 0;
          const stagVal  = actor.system.stagger?.value ?? 0;
          lines.push(`  - ${actor.name}: light=${lightVal}/${lightMax}, stagger=${stagVal}/${stagMax}`);
          const sceneEndStatuses = actor.items.filter(i =>
            i.type === "status" && i.system.scene_end_effect?.operator
          );
          for (const s of sceneEndStatuses) {
            const op  = s.system.scene_end_effect.operator;
            const val = s.system.scene_end_effect.variable ?? "";
            lines.push(`    → ${s.name} (count=${s.system.count}): scene_end_effect operator="${op}" variable="${val}"`);
          }
        }
      }
      const report = lines.join("\n");
      console.log(report);
      ChatMessage.create({
        content: `<div style="font-family:monospace;font-size:11px;background:#0d0b15;border:1px solid #3a2060;border-radius:6px;padding:10px;white-space:pre-wrap;color:#ccc;">${report.replace(/\n/g, "<br>").replace(/⚠/g, '<span style="color:#e07070">⚠</span>')}</div>`,
        whisper: [game.user.id]
      });
      return report;
    }
  };

  // ── GM actor-update relay ──────────────────────────────────────────────────
  // Players can't directly update actors they don't own. Instead they create a
  // hidden ChatMessage with a sotc.actorDelta flag. The active GM detects it,
  // applies the delta, then deletes the relay message.
  if (game.user.isGM) {
    Hooks.on("createChatMessage", async (message) => {
      const delta = message.getFlag("sotc", "actorDelta");
      if (!delta) return;
      if (!game.users.activeGM?.isSelf) return;

      try { await message.delete(); } catch (e) { /* already deleted */ }

      const actor = game.actors.get(delta.actorId)
        ?? canvas.tokens?.placeables?.find(t => t.actor?.id === delta.actorId)?.actor
        ?? null;
      if (!actor) { console.warn(`sotc | relay: actor ${delta.actorId} not found`); return; }

      const d       = delta.delta;
      const updates = {};
      if (d.hp          !== undefined) updates["system.health.value"]  = (actor.system.health.value  ?? 0) + d.hp;
      if (d.stagger     !== undefined) { const c = actor.system.stagger.value ?? 0, m = actor.system.stagger.max ?? c; updates["system.stagger.value"] = Math.max(0, Math.min(m, c + d.stagger)); }
      if (d.staggerGain !== undefined) { const c = actor.system.stagger.value ?? 0, m = actor.system.stagger.max ?? c; updates["system.stagger.value"] = Math.min(m, c + d.staggerGain); }
      if (d.emotion     !== undefined) { const c = actor.system.emotion ?? 0, m = actor.system.emotion_max ?? actor.system.emotionMax ?? 99; updates["system.emotion"] = Math.max(0, Math.min(m, c + d.emotion)); }

      if (Object.keys(updates).length) {
        try { await actor.update(updates); }
        catch (err) { console.error(`sotc | relay: update failed for ${actor.name}:`, err); }
      }
    });
  }

  // ── Startup cleanup: purge duplicate sotc ActiveEffects ───────────────────
  if (game.user.isGM && game.users.activeGM?.isSelf) {
    (async () => {
      let totalCleaned = 0;
      for (const actor of game.actors) {
        const byItem = new Map();
        for (const e of actor.effects) {
          const key = e.flags?.sotc?.statusItemId ?? (e.statuses?.size === 1 ? [...e.statuses][0] : null);
          if (!key) continue;
          if (!byItem.has(key)) byItem.set(key, []);
          byItem.get(key).push(e.id);
        }
        const toDelete = [];
        for (const [, ids] of byItem) {
          if (ids.length > 1) toDelete.push(...ids.slice(1));
        }
        if (toDelete.length) {
          try {
            await actor.deleteEmbeddedDocuments("ActiveEffect", toDelete);
            totalCleaned += toDelete.length;
          } catch (err) {
            // Silently ignore — effects may have already been cleaned up
          }
        }
      }
      if (totalCleaned > 0) {
        console.log(`sotc | Startup cleanup removed ${totalCleaned} duplicate ActiveEffect(s).`);
      }
    })();
  }

  // ── game.sotc.updateActor ──────────────────────────────────────────────────
  // Applies stat deltas to an actor. If the GM: direct update using fresh data.
  // If a player without ownership: relays delta via hidden ChatMessage.
  game.sotc.updateActor = async function (actor, delta) {
    if (!actor || !Object.keys(delta ?? {}).length) return;

    const isActiveGM = game.user.isGM && game.users.activeGM?.isSelf;

    const buildUpdates = (a, d) => {
      const u = {};
      if (d.hp !== undefined)
        u["system.health.value"]  = (a.system.health.value  ?? 0) + d.hp;
      if (d.stagger !== undefined) {
        const c = a.system.stagger.value ?? 0, m = a.system.stagger.max ?? c;
        u["system.stagger.value"] = Math.max(0, Math.min(m, c + d.stagger));
      }
      if (d.staggerGain !== undefined) {
        const c = a.system.stagger.value ?? 0, m = a.system.stagger.max ?? c;
        u["system.stagger.value"] = Math.min(m, c + d.staggerGain);
      }
      if (d.emotion !== undefined) {
        const c = a.system.emotion ?? 0, m = a.system.emotion_max ?? a.system.emotionMax ?? 99;
        u["system.emotion"] = Math.max(0, Math.min(m, c + d.emotion));
      }
      // Legacy: absolute value keys passed directly (from combatRound etc.)
      for (const k of Object.keys(d).filter(k => k.startsWith("system."))) u[k] = d[k];
      return u;
    };

    if (isActiveGM || actor.isOwner) {
      const updates = buildUpdates(actor, delta);
      if (Object.keys(updates).length) {
        try { await actor.update(updates); }
        catch (err) { console.error(`sotc | direct update failed for ${actor.name}:`, err); }
      }
    } else {
      if (!game.users.activeGM) {
        ui.notifications.warn("No active GM — cannot apply changes.");
        return;
      }
      await ChatMessage.create({
        content: "",
        whisper: [],
        flags:   { sotc: { actorDelta: { actorId: actor.id, delta } } },
        style:   CONST.CHAT_MESSAGE_STYLES.OTHER,
        speaker: { alias: "sotc-relay" }
      });
    }
  };

  // ── Tracker initialisation ─────────────────────────────────────────────────
  // Done here (inside the ready hook, after game.sotc exists) so that
  // game.sotc.egoPassiveTracker / enemyRevealTracker are set before init() runs.
  // Previously this lived in damage.js's own ready hook which fired BEFORE
  // sotc.js's ready hook, crashing because game.sotc was still undefined.
  game.sotc.egoPassiveTracker  = _egoPassiveTracker;
  game.sotc.enemyRevealTracker = _enemyRevealTracker;

  // Stamp current message IDs so renderChatMessage only auto-tracks NEW ones.
  _enemyRevealTracker._oldMessageIds = new Set(game.messages.map(m => m.id));

  if (game.settings.get("sotc", "egoPassiveTrackerEnabled"))
    setTimeout(() => _egoPassiveTracker.init(), 500);
  if (game.settings.get("sotc", "enemyRevealTrackerEnabled"))
    setTimeout(() => _enemyRevealTracker.init(), 600);
});

/* -------------------------------------------- */
/*  Directory context menus                      */
/* -------------------------------------------- */

Hooks.on("getActorDirectoryEntryContext", (html, options) => {
  options.push({
    name:      game.i18n.localize("SOTC.DefineTemplate"),
    icon:      '<i class="fas fa-stamp"></i>',
    condition: li => !game.actors.get(li.data("documentId")).isTemplate,
    callback:  li =>  game.actors.get(li.data("documentId")).setFlag("sotc", "isTemplate", true)
  });
  options.push({
    name:      game.i18n.localize("SOTC.UnsetTemplate"),
    icon:      '<i class="fas fa-times"></i>',
    condition: li =>  game.actors.get(li.data("documentId")).isTemplate,
    callback:  li =>  game.actors.get(li.data("documentId")).setFlag("sotc", "isTemplate", false)
  });
});

Hooks.on("getItemDirectoryEntryContext", (html, options) => {
  options.push({
    name:      game.i18n.localize("SOTC.DefineTemplate"),
    icon:      '<i class="fas fa-stamp"></i>',
    condition: li => !game.items.get(li.data("documentId")).isTemplate,
    callback:  li =>  game.items.get(li.data("documentId")).setFlag("sotc", "isTemplate", true)
  });
  options.push({
    name:      game.i18n.localize("SOTC.UnsetTemplate"),
    icon:      '<i class="fas fa-times"></i>',
    condition: li =>  game.items.get(li.data("documentId")).isTemplate,
    callback:  li =>  game.items.get(li.data("documentId")).setFlag("sotc", "isTemplate", false)
  });
});
