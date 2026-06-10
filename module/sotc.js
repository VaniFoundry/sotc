/**
 * An adaptation of Atropos' simple and flexible system that makes it less simple and hopefully still flexible.
 * Author: Tsubasa
 */

// Import Modules
import { SotCActor } from "./actor.js";
import { SotCItem } from "./item.js";
import { SotCActorSheet } from "./actor-sheet.js";
import { SotCSkillSheet } from "./skill-sheet.js";
import { SotCStatusSheet } from "./status-sheet.js";
import { SotCPassiveSheet } from "./passive-sheet.js";
import { SotCToken, SotCTokenDocument } from "./token.js";
import { preloadHandlebarsTemplates } from "./templates.js";
import { createSotCMacro } from "./macro.js";
import { SOTCHotbar } from "./macro.js";
import { enrichModWithStatusIcons, KeywordConfigApp } from "./helper.js";

/* -------------------------------------------- */
/*  Foundry VTT Initialization                  */
/* -------------------------------------------- */



/**
 * Init hook.
 */
Hooks.once("init", async function() {
  console.log("Initializing SotC");


  /**
   * This doesn't really matter that much, mainly just setting the decimal value and providing a base intiative if you flub it in character creation somehow, or if there's a mistake on my end haha.
   * @type {String}
   */
  CONFIG.Combat.initiative = {
    formula: "1d6",
    decimals: 2
  };

  // This APPEARS to work, but I don't think it's the most durable solution I could use, but in the end it does have a failsafe in case things explode a little bit
  // This SHOULD affect when initiative is rolled via the roll all button, the roll NPC button (NPCs don't exist yet but pretend that I'm not dumb (or if they do exist pretend that I came back and commented this out))
  // And then also by clicking the dice button to roll initiative. I'm only unsure of if this works durably now because I didn't document it fully initially.
  // Anyways, in the future I'll probably add something that lets the user modify the dice when clicking to roll initiative
  class SotCCombat extends Combat {
    async rollInitiative(ids, { formula = null, updateTurn = true, messageOptions = {} } = {}) {
      ids = typeof ids === "string" ? [ids] : ids;
      const combatants = this.combatants.filter(c => ids.includes(c.id));
      const updates = [];
      
      function computeSpeedModFromStatuses(actor, baseFormula) {
        if (!actor) return 0;
        let speed_mod = 0;

        // Generic passive status modifiers targeting speed (skip Haste/Bind — handled separately below)
        const statuses = actor.items.filter(i => i.type === "status" && (i.system?.condition === "passive") && (Number(i.system?.count) > 0));
        for (const status of statuses) {
          if (["haste", "bind"].includes(status.name.toLowerCase())) continue;
          const { effect, target, potency_flat = 0, potency = 0, count = 0 } = status.system;
          if (!target) continue;
          const sign = (effect === "Increase") ? 1 : -1;
          const bonus = (Number(potency_flat || 0) + Number(potency || 0) * Number(count || 0)) * sign;
          if (target === "speed") speed_mod += bonus;
        }

        // Haste: +count flat to roll. Bind: -count flat, clamped so result >= 1
        const hasteStatus = actor.items.find(i => i.type === "status" && i.name.toLowerCase() === "haste" && Number(i.system?.count) > 0);
        const bindStatus  = actor.items.find(i => i.type === "status" && i.name.toLowerCase() === "bind"  && Number(i.system?.count) > 0);
        const hasteCount  = hasteStatus ? Number(hasteStatus.system.count) : 0;
        const bindCount   = bindStatus  ? Number(bindStatus.system.count)  : 0;

        if (hasteCount || bindCount) {
          const baseMin = (() => {
            const m = (baseFormula ?? "1d6").match(/^(\d+)d(\d+)/i);
            return m ? Number(m[1]) : 1;
          })();
          const net = hasteCount - bindCount;
          const clamped = Math.max(1 - baseMin, net);
          speed_mod += clamped;
        }

        return Number(speed_mod) || 0;
      }

      for (let c of combatants) {
        const actorId = c.actorId;
        const base_combatant = this.combatants.find(b =>
        b.actorId === actorId && !b.flags?.sotc?.isSpeedDieClone
      ) ?? c;
        
        const actor = base_combatant.actor;
        if (!actor) continue;
        await actor.prepareData();
        await actor.prepareDerivedData();

        const actor_formula = actor?.system?.speed_dice?.dice_size;
        let total_formula = `${actor_formula}`

        const status_speed_mod = computeSpeedModFromStatuses(actor, actor_formula);
        const stored_speed_mod = actor?.system?.modifiers.speed_mod ?? 0;
        const init_mod = status_speed_mod || stored_speed_mod || 0;

        const actor_type = actor?.system?.initiative_type;
        
        if (init_mod > 0) {
          total_formula = `${total_formula}+${init_mod}`;
        } 
        else if (init_mod < 0) {
          total_formula = `${total_formula}-${-init_mod}`;
        }
        // const isSpeedDie = c.flags?.sotc?.isSpeedDieClone; <- Not Needed in the current version 
        const final_formula = (total_formula && Roll.validate(total_formula))
          ? total_formula
          : formula || CONFIG.Combat.initiative.formula; // This is our given failsafe

        const roll = await (new Roll(final_formula).evaluate({ async: true }));
        let final_init = Math.max(1, roll.total);
        if (actor_type === "player") {
          final_init = final_init+0.01
        }

        updates.push({ _id: c.id, initiative: final_init });

        // Clear Haste and Bind on the base actor now that their bonus has been applied
        const hasteToClear = actor.items.find(i => i.type === "status" && i.name.toLowerCase() === "haste" && Number(i.system?.count) > 0);
        const bindToClear  = actor.items.find(i => i.type === "status" && i.name.toLowerCase() === "bind"  && Number(i.system?.count) > 0);
        const clearUpdates = [];
        if (hasteToClear) clearUpdates.push({ _id: hasteToClear.id, "system.count": 0 });
        if (bindToClear)  clearUpdates.push({ _id: bindToClear.id,  "system.count": 0 });
        if (clearUpdates.length) await actor.updateEmbeddedDocuments("Item", clearUpdates);

        // In grouping mode (called from rollAll), collect data instead of posting messages
        if (this._sotcGroupInitiative) {
          this._sotcGroupInitiative.push({
            name:    c.name,
            img:     c.actor?.img ?? "icons/svg/mystery-man.svg",
            formula: final_formula,
            rolled:  roll.total - init_mod,
            mod:     init_mod,
            final:   final_init,
            type:    actor_type
          });
        } else {
          await roll.toMessage({
            speaker: ChatMessage.getSpeaker({ actor: c.actor }),
            flavor: game.i18n.format("SOTC.CombatInitiativeRoll", {name: c.name, rolled: roll.total - init_mod, final: final_init}),
            sound: CONFIG.sounds.dice ?? null,
          }, messageOptions);
        }
      }

      // Update initiatives
      await this.updateEmbeddedDocuments("Combatant", updates);
      if (updateTurn) this.update({ turn: this.turns.findIndex(t => t.initiative !== null) });
      return this;
    }

    async rollAll(options = {}) {
      const ids = this.combatants
        .filter(c => c.initiative === null)
        .map(c => c.id);
      if (!ids.length) return this;

      // Enable grouping mode — rollInitiative pushes row data here instead of posting messages
      this._sotcGroupInitiative = [];

      const originalSound = CONFIG.sounds.dice;
      CONFIG.sounds.dice = null;
      try {
        await this.rollInitiative(ids, options);
      } finally {
        CONFIG.sounds.dice = originalSound;
      }

      // Play once
      if (originalSound) {
        foundry.audio.AudioHelper.play({ src: originalSound, volume: 0.8, autoplay: true, loop: false }, true);
      }

      // ── Post grouped initiative card ─────────────────────────────────────
      const initRows = this._sotcGroupInitiative ?? [];
      delete this._sotcGroupInitiative;

      if (initRows.length) {
        const round = this.round ?? 1;
        const playerRows = initRows.filter(r => r.type === "player").sort((a,b) => b.final - a.final);
        const enemyRows  = initRows.filter(r => r.type !== "player").sort((a,b) => b.final - a.final);
        const allRows    = [...playerRows, ...enemyRows];

        const typeColor  = r => r.type === "player" ? "#4caf7d" : "#e05050";
        const modStr     = r => r.mod > 0 ? `+${r.mod}` : r.mod < 0 ? `${r.mod}` : "";

        const rowsHtml = allRows.map(r => `
          <div style="display:flex; align-items:center; gap:8px; padding:3px 0; border-top:1px solid #1e1c2a;">
            <img src="${r.img}" style="width:22px; height:22px; border-radius:50%; object-fit:cover; border:1px solid #3a3050; flex-shrink:0;">
            <span style="flex:1; font-size:12px; color:#ddd;">${r.name}</span>
            <span style="font-size:11px; color:#888;">${r.formula}${modStr(r) ? ` ${modStr(r)}` : ""} = ${r.rolled}</span>
            <span style="font-size:12px; font-weight:700; color:${typeColor(r)}; min-width:24px; text-align:right;">${Math.floor(r.final)}</span>
          </div>`).join("");

        const topResult = allRows[0];
        const previewText = topResult
          ? `<span style="font-size:11px; color:#aaa;">${game.i18n.format("SOTC.CombatInitiativeTop", {name: topResult.name, value: Math.floor(topResult.final), count: initRows.length})}</span>`
          : `<span style="font-size:11px; color:#aaa;">${game.i18n.format("SOTC.CombatInitiativeRolled", {count: initRows.length})}</span>`;

        const cardHtml = `
          <div style="background:#12111a; border:1px solid #3a3050; border-radius:6px; padding:10px 12px; font-family:'Signika',sans-serif; line-height:1.6;">
            <div class="sotc-init-toggle" style="display:flex; justify-content:space-between; align-items:center; cursor:pointer; user-select:none; margin-bottom:4px;">
              <div style="display:flex; align-items:center; gap:6px;">
                <i class="fas fa-chevron-down sotc-init-chevron" style="font-size:10px; color:#888; transition:transform 0.15s;"></i>
                <strong style="color:#e8d9a0; font-size:14px;">${game.i18n.format("SOTC.CombatInitiativeRound", {round})}</strong>
              </div>
              ${previewText}
            </div>
            <div class="sotc-init-rows" data-collapsed="false">${rowsHtml}</div>
          </div>`;

        await ChatMessage.create({
          speaker: { alias: game.i18n.localize("SOTC.CombatAlias") },
          content: cardHtml,
          flags: { sotc: { initiativeGroup: true } }
        });
      }

      return this;
    }
  }

  CONFIG.Combat.documentClass = SotCCombat;
  
  game.sotc = {
    SotCActor,
    createSotCMacro
  };

  // Define our custom Document classes. The SotCTokenDocument and SotCToken classes aren't vestigial, but I never interacted with them.
  // If I just lied to you and I DID change them, it's because I didn't come back to change this comment. Haha I'm great at this either way.
  CONFIG.Actor.documentClass = SotCActor;
  CONFIG.Item.documentClass = SotCItem;
  CONFIG.Token.documentClass = SotCTokenDocument;
  CONFIG.Token.objectClass = SotCToken;

  // More work, specifically for our Actor sheets and Item sheets.
  CONFIG.Actor.types = ["character"]; // No NPC Yet!!!!!!
  CONFIG.Item.types = ["skill", "ego", "status", "passive"];
  CONFIG.Actor.typeLabels = {
    character: game.i18n.localize("SOTC.ActorTypeCharacter"),
  //  npc: "NPC"  <- Still Not Yet!!!!!!!!!!
  };
  CONFIG.Item.typeLabels = {
    skill: game.i18n.localize("SOTC.ItemTypeSkill"),
    ego: game.i18n.localize("SOTC.ItemTypeEgo"),
    status: game.i18n.localize("SOTC.ItemTypeStatus"),
    passive: game.i18n.localize("SOTC.ItemTypePassive")
  };

  // Register sheet application classes
  Actors.unregisterSheet("core", foundry.appv1.sheets.ActorSheet);
  Actors.registerSheet("sotc", SotCActorSheet, {types: ["character"], makeDefault: true});
  Items.unregisterSheet("core", foundry.appv1.sheets.ItemSheet);
  Items.registerSheet("sotc", SotCSkillSheet, {types: ["skill", "ego"], makeDefault: true});
  Items.registerSheet("sotc", SotCStatusSheet, {types: ["status"]});
  Items.registerSheet("sotc", SotCPassiveSheet, {types: ["passive"]});


  // Register system settings
  game.settings.register("sotc", "macroShorthand", {
    name: "SETTINGS.SotCMacroShorthandN",
    hint: "SETTINGS.SotCMacroShorthandL",
    scope: "sotc",
    type: Boolean,
    default: true,
    config: true
  });

  // Chat keyword icon config — stored as JSON, managed via custom menu
  game.settings.register("sotc", "chatKeywords", {
    name: "SETTINGS.SotCChatKeywordsN",
    hint: "SETTINGS.SotCChatKeywordsL",
    scope: "world",
    type: String,
    default: "[]",
    config: false   // hidden from default settings UI — managed via the menu below
  });

  game.settings.register("sotc", "restoreStaggerOnCombatEnd", {
    name: "SETTINGS.SotCRestoreStaggerN",
    hint: "SETTINGS.SotCRestoreStaggerL",
    scope: "world",
    type: Boolean,
    default: true,
    config: true
  });

  game.settings.register("sotc", "restoreLightOnCombatEnd", {
    name: "SETTINGS.SotCRestoreLightN",
    hint: "SETTINGS.SotCRestoreLightL",
    scope: "world",
    type: Boolean,
    default: true,
    config: true
  });

  game.settings.register("sotc", "playerDamageWizard", {
    name: "SETTINGS.SotCPlayerDamageWizardN",
    hint: "SETTINGS.SotCPlayerDamageWizardL",
    scope: "world",
    type: Boolean,
    default: false,
    config: true
  });

  // ── Alternate Rules ───────────────────────────────────────────────────────
  game.settings.register("sotc", "enemyEmotionPoints", {
    name: "SETTINGS.SotCEnemyEmotionPointsN",
    hint: "SETTINGS.SotCEnemyEmotionPointsL",
    scope: "world",
    type: Boolean,
    default: false,
    config: true
  });

  game.settings.register("sotc", "sinkingEnemyEmotionPoints", {
    name: "SETTINGS.SotCSinkingEnemyEmotionPointsN",
    hint: "SETTINGS.SotCSinkingEnemyEmotionPointsL",
    scope: "world",
    type: Boolean,
    default: false,
    config: true
  });

  game.settings.register("sotc", "sinkingPlayerEmotionPoints", {
    name: "SETTINGS.SotCSinkingPlayerEmotionPointsN",
    hint: "SETTINGS.SotCSinkingPlayerEmotionPointsL",
    scope: "world",
    type: Boolean,
    default: true,
    config: true
  });

  // ── Inject section dividers ───────────────────────────────────────────────
  // Foundry has no native grouping API so we hook renderSettingsConfig.
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

    // GM Settings divider before playerDamageWizard
    const gmRow = html.find(`[data-setting-id="sotc.playerDamageWizard"]`).closest(".form-group");
    if (gmRow.length) gmRow.before(divider(game.i18n.localize("SETTINGS.SotCGMSettingsDivider"), "fas fa-shield-alt", "#7ab8e0", "#2a5a7a"));

    // Alternate Rules divider before enemyEmotionPoints
    const altRow = html.find(`[data-setting-id="sotc.enemyEmotionPoints"]`).closest(".form-group");
    if (altRow.length) altRow.before(divider(game.i18n.localize("SETTINGS.SotCAlternateRulesDivider"), "fas fa-dice-d20", "#c090e0", "#5a3a6a"));
  });

  // Settings menu button that opens the KeywordConfigApp
  game.settings.registerMenu("sotc", "chatKeywordsMenu", {
    name: "SETTINGS.SotCChatKeywordsN",
    label: "SETTINGS.SotCChatKeywordsMenuLabel",
    hint: "SETTINGS.SotCChatKeywordsMenuHint",
    icon: "fas fa-icons",
    type: KeywordConfigApp,
    restricted: true   // GM only
  });

  /**
   * Slugify a string.
   */
  Handlebars.registerHelper('slugify', function(value) {
    return value.slugify({strict: true});
  });

  /**
   * Shamelessly stolen, naturally, for the sake of having access to these when I need them.
   */  
  Handlebars.registerHelper({
    eq: (v1, v2) => v1 === v2,
    ne: (v1, v2) => v1 !== v2,
    lt: (v1, v2) => v1 < v2,
    gt: (v1, v2) => v1 > v2,
    lte: (v1, v2) => v1 <= v2,
    gte: (v1, v2) => v1 >= v2,
    and() {
        return Array.prototype.every.call(arguments, Boolean);
    },
    or() {
        return Array.prototype.slice.call(arguments, 0, -1).some(Boolean);
    }
  });

  // ── Actor update relay via hidden ChatMessage ─────────────────────────────
  // game.socket is unreliable in Foundry v13 for systems. Instead, players
  // create a hidden ChatMessage with a sotc flag containing the delta.
  // The GM watches for these messages and applies the update, then deletes the message.
  game.socket.on("system.sotc", async (data) => {
    if (!data?.type) return;

    // ── Safeguard prompt ──────────────────────────────────────────────────────
    // GM sends this to the owning player's client so they see an interactive dialog.
    // safeguardPrompt is now handled via chat message buttons — no socket needed
  });

  // Preload template partials
  await preloadHandlebarsTemplates();
});

/**
 * Macrobar hook.
Hooks.on("hotbarDrop", async (bar, data, slot) => {
  if (data.type !== "Item") return true;

  const item = await fromUuid(data.uuid);
  if (!item) return true;

  if (!["skill", "ego"].includes(item.type)) return true;

  await SOTCHotbar.createSkillMacro(item, slot);
  return false;
});
 */

/**
 * Adds the actor template context menu.
 */
Hooks.on("getActorDirectoryEntryContext", (html, options) => {

  // Define an actor as a template.
  options.push({
    name: game.i18n.localize("SOTC.DefineTemplate"),
    icon: '<i class="fas fa-stamp"></i>',
    condition: li => {
      const actor = game.actors.get(li.data("documentId"));
      return !actor.isTemplate;
    },
    callback: li => {
      const actor = game.actors.get(li.data("documentId"));
      actor.setFlag("sotc", "isTemplate", true);
    }
  });

  // Undefine an actor as a template.
  options.push({
    name: game.i18n.localize("SOTC.UnsetTemplate"),
    icon: '<i class="fas fa-times"></i>',
    condition: li => {
      const actor = game.actors.get(li.data("documentId"));
      return actor.isTemplate;
    },
    callback: li => {
      const actor = game.actors.get(li.data("documentId"));
      actor.setFlag("sotc", "isTemplate", false);
    }
  });
});

/**
 * Adds the item template context menu.
 */
Hooks.on("getItemDirectoryEntryContext", (html, options) => {

  // Define an item as a template.
  options.push({
    name: game.i18n.localize("SOTC.DefineTemplate"),
    icon: '<i class="fas fa-stamp"></i>',
    condition: li => {
      const item = game.items.get(li.data("documentId"));
      return !item.isTemplate;
    },
    callback: li => {
      const item = game.items.get(li.data("documentId"));
      item.setFlag("sotc", "isTemplate", true);
    }
  });

  // Undefine an item as a template.
  options.push({
    name: game.i18n.localize("SOTC.UnsetTemplate"),
    icon: '<i class="fas fa-times"></i>',
    condition: li => {
      const item = game.items.get(li.data("documentId"));
      return item.isTemplate;
    },
    callback: li => {
      const item = game.items.get(li.data("documentId"));
      item.setFlag("sotc", "isTemplate", false);
    }
  });
});

Hooks.on("renderCombatTracker", (app, html, data) => {
  const root = html instanceof HTMLElement ? html : html[0];
  if (!root) return;
  const $html = $(root);

  $html.find(".combatant").each((_, el) => {
    const $el = $(el);

    // If we don't actively remove the status effects then they end up supremely cluttering the initiative tracker
    $el.find(".token-effects img").each((_, img) => {
      const statusId = img.dataset.statusId;

      // This one is necessary to keep, obviously
      if (statusId !== "dead") {
        img.remove();
      }
    });
  });

  for (const li of root.querySelectorAll(".combatant")) {
    const combatantId = li.dataset.combatantId;
    const combatant = game.combat.combatants.get(combatantId);

    const isUsed = combatant.flags?.sotc?.used;

    // Get the .combatant-controls div
    const controls = li.querySelector(".combatant-controls");
    if (!controls) continue;

    const usedButton = document.createElement("a");
    usedButton.classList.add("combatant-control");
    usedButton.dataset.control = "toggleUsedSpeedDie";
    usedButton.dataset.tooltip = game.i18n.localize("SOTC.CombatToggleSpeedDie");
    usedButton.setAttribute("aria-label", game.i18n.localize("SOTC.CombatToggleSpeedDie"));
    usedButton.setAttribute("role", "button");

    // Icon reflects use state yippeeeeee
    const icon = document.createElement("img");
    icon.src = isUsed ? "systems/sotc/assets/icons/used.png" : "systems/sotc/assets/icons/unused.png";
    icon.alt = game.i18n.localize("SOTC.CombatUsedSpeedDie");
    icon.style.width = "20px";
    icon.style.height = "20px";
    icon.classList.add("used_and_unused_icons");
    usedButton.appendChild(icon);

    if (combatant.isOwner || game.user.isPrimaryGM) {
      usedButton.addEventListener("click", async (ev) => {
        ev.preventDefault();
        const newUsed = !isUsed;
        await combatant.setFlag("sotc", "used", newUsed);
      });
    } else {
      usedButton.style.pointerEvents = "none";
      usedButton.style.opacity = "0.0";
    }

    // Append the button to the controls, which looks only a little jank
    controls.appendChild(usedButton);

    // Visually mark the row as used by...
    li.classList.toggle("used-speed-die", isUsed);

    // ... greying it out
    if (isUsed) {
      li.style.opacity = "0.4";
    } else {
      li.style.opacity = "";
    }
  }
});

Hooks.on("createCombatant", async (combatant, options, userId) => {
  // If someone other than the gm runs the code (as it's run client side), then things get messy and we get duplicate entries
  // As pointed out to me by _twitch_ my former fix of "if (!game.user.isGM) return;" did not work, because we could have assistant GMs in the mix
  // Now, we let each machine conduct this step, checking to see if they made the combatant. If not, they do nothing, and if so then make the duplicates!
  if (typeof userId === "string") {
    if (userId !== game.user.id) return;
  } else {
    // Fallback, will have the same issue for multiple connected machines
    if (!game.user.isGM) return;
  }

  if (combatant.flags?.sotc?.isSpeedDieClone) return;
  const actor = combatant.actor;
  if (!actor || !actor.system?.speed_dice) return;

  // Sum up extra speed dice from any passive status with target "number of speed dice"
  let extra_dice = 0;
  for (const s of actor.items.filter(i =>
    i.type === "status" &&
    i.system?.condition === "passive" &&
    i.system?.target === "number of speed dice" &&
    Number(i.system?.count) > 0
  )) {
    const sign = s.system.effect === "Decrease" ? -1 : 1;
    const flat = Number(s.system.potency_flat ?? 0);
    const pot  = Number(s.system.potency ?? 0);
    const cnt  = Number(s.system.count ?? 0);
    extra_dice += (flat + pot * cnt) * sign;
  }

  const base_num_dice = Number(actor.system.speed_dice.num_dice ?? 1);
  const temp_num_dice = base_num_dice + extra_dice;

  if (temp_num_dice <= 1) return;

  // Capture references before the setTimeout — combatant.parent may not be
  // accessible after yielding if Foundry garbage-collects the reference.
  const combat        = combatant.parent;
  const actorId       = actor.id;
  const tokenId       = combatant.tokenId;
  const combatantName = combatant.name;

  if (!combat) {
    return;
  }

  setTimeout(async () => {
    for (let i = 1; i < temp_num_dice; i++) {
      await combat.createEmbeddedDocuments("Combatant", [{
        actorId,
        tokenId,
        hidden: false,
        initiative: null,
        name: `${combatantName} #${i + 1}`,
        flags: {
          sotc: {
            isSpeedDieClone: true,
            speedDieIndex: i
          }
        }
      }]);
    }
  }, 50);
});

Hooks.on("deleteCombatant", async (combatant, options, userId) => {
  const combat = combatant.parent;
  const actorId = combatant.actorId;
  const tokenId = combatant.tokenId;
  if (!actorId || !tokenId) return;

  // Remove only other combatants that are clones of THIS token
  const toRemove = combat.combatants.filter(c =>
    c.actorId === actorId &&
    c.tokenId === tokenId &&
    c.id !== combatant.id &&
    c.getFlag("sotc", "isSpeedDieClone")
  );

  if (toRemove.length > 0) {
    await combat.deleteEmbeddedDocuments("Combatant", toRemove.map(c => c.id));
  }
});

// Now we take care of our initiative, compensating for the dice being of variable size and power
// I can't remember, do I even use this anywhere?
Hooks.on("preRollInitiative", (combat, combatants, rollOptions) => {
  for (let combatant of combatants) {
    const actor = combatant.actor;
    // Not Needed? -> const isSpeedDie = combatant.flags?.sotc?.isSpeedDieClone;
    const actorFormula = actor?.system?.speed_dice?.dice_size;
    const actorType = actor?.system?.initiative_type

    // Only override formula if valid and a speed die clone
    if (actorFormula && Roll.validate(actorFormula)) {

      if (actorType === "player") {
        const total = actorFormula + 0.01
        rollOptions.formula = total
      } else {
        rollOptions.formula = actorFormula
      }
    }
  }
});

// Our most wonderful helper function which accepts the values provided by the status effect created by a user and returns to us the new value for the status effect
// This doth make for a much more elegant solution than _onPostActive, but you shant see me replace _onPostActive with this update. I am, haha, uhhh, busy
function applyOperator(value, operator, variable = 0) {
  switch (operator) {
    case "maintain": return value;
    case "clear": return 0;
    case "add": return value + variable;
    case "subtract": return Math.max(value - variable, 0);
    case "multiply": return value * variable;
    case "divide": return Math.floor(value / Math.max(variable, 1));
    default: return value;
  }
}

// New scene, new initiative! We don't currently preserve the previous round's initiative which SUCKS for the sake of accidentally skipping a round
Hooks.on("combatRound", async (combat, round) => {
  // Only the active GM runs this hook — prevents duplicate writes and permission
  // errors when non-owners try to update player-controlled actors.
  if (!game.user.isGM || !game.users.activeGM?.isSelf) return;

  const combatant_updates = [];
  const processed_actors = new Set();

  for (let c of combat.combatants) {
    const actor_updates = {};
    const actor_stag_updates = {};
    const actor = c.actor;

    if (!actor?.system?.speed_dice) continue; // I don't really know WHY we would, but in case you're using an actor in combat with no speed dice then uhhh, yeah?

    const stag_status_updates = [];
    const stag_statuses = actor.items.filter(i => i.type === "status" && (i.system.condition === "stagger_like") && (i.system.count > 0));
    for (const stag_status of stag_statuses) {
      if (round.round >= stag_status.system.stagger_end) {
        if (stag_status.system.stagger_effects?.reset_stagger) {
          actor_stag_updates["system.stagger.value"] = actor.system.stagger.max
        }
        stag_status_updates.push({
          _id: stag_status.id,
          "system.count": 0
        });
      }
    }

    if (stag_status_updates.length) {
      await actor.updateEmbeddedDocuments("Item", stag_status_updates);
    }

    const modifiers = actor.system.modifiers ?? {};
    if (!modifiers.null_speed_dice) {
      combatant_updates.push({
        _id: c.id,
        initiative: null,
        "flags.sotc.used": false
      });
    }

    // The above affect should trigger for all instances of a combatant (all speed dice), while everything below this point should only trigger once for an actor
    if (processed_actors.has(actor.id)) continue;
    processed_actors.add(actor.id);

    const status_updates = [];
    const statuses = actor.items.filter(i => i.type === "status" && (i.system.condition !== "stagger_like") && (i.system.count > 0));

    // Capture IDs of active speed-dice statuses before the loop so we can detect expiry after flush
    const pre_flush_speed_dice_ids = new Set(
      statuses
        .filter(i => i.system?.condition === "passive" && i.system?.target === "number of speed dice")
        .map(i => i.id)
    );

    // Accumulate HP and stagger deltas so multiple statuses targeting the same
    // resource don't overwrite each other in actor_updates.
    let accumulated_hp_delta = 0;
    let accumulated_hp_min   = 0;
    let accumulated_stg_delta = 0;
    let accumulated_stg_min   = 0;
    let hp_affected  = false;
    let stg_affected = false;

    // ─────────────────────────────────────────────────────────────────────────
    for (const status of statuses) {
      // Haste and Bind are cleared in rollInitiative after being applied — skip them here
      if (["haste", "bind"].includes(status.name.toLowerCase())) continue;

      // Duration expiry — only when use_duration is enabled and for passive/stagger_like.
      // Active conditions use scene_end_effect to count down and must NOT be hard-expired here.
      const _use_duration = status.system.use_duration ?? false;
      const _stagger_end  = Number(status.system.stagger_end ?? 0);
      const _duration     = Number(status.system.stagger_duration ?? 0);
      const _condition    = status.system.condition;
      if (_use_duration && _duration > 0 && _stagger_end > 0 && round.round >= _stagger_end &&
          (_condition === "passive" || _condition === "stagger_like")) {
        status_updates.push({ _id: status.id, "system.count": 0, "system.stagger_end": null });
        continue;
      }

      // Sinking (and Sinking Deluge) are handled specially
      const endOp = status.system.scene_end_effect?.operator;
      if (status.name.toLowerCase() === "sinking" || status.name.toLowerCase() === "sinking deluge") {
        const inflict = Number(status.system.count ?? 0);
        if (inflict > 0) {
          const curr = Number(actor.system.stagger.value ?? 0);
          const maxs = Number(actor.system.stagger.max ?? curr);
          // Use scene_end_effect.min_resource_limit as the floor (1 for Sinking, 0 for Sinking Deluge)
          const sinkingFloor = Number(status.system.scene_end_effect?.min_resource_limit ?? 0);
          actor_stag_updates["system.stagger.value"] = Math.max(sinkingFloor, Math.min(maxs, curr - inflict));
          const newc = Math.floor(inflict / 2);
          status_updates.push({
            _id: status.id,
            "system.count": newc
          });
          const isPlayer = actor.system.initiative_type === "player";
          const isEnemy  = !isPlayer;
          const playerEPEnabled = game.settings.get("sotc", "sinkingPlayerEmotionPoints");
          const enemyEPEnabled  = game.settings.get("sotc", "sinkingEnemyEmotionPoints");
          if ((isPlayer && playerEPEnabled) || (isEnemy && enemyEPEnabled)) {
            const cure = Number(actor.system.emotion ?? 0);
            actor_updates["system.emotion"] = Math.max(0, cure - Math.floor(inflict / 2));
          }
        }
      } else if (endOp && endOp !== "maintain") {
        // Generic active status — compute delta from CURRENT count BEFORE decrement
        // so the last tick always fires (fixes "count 1→0 skips damage" bug).
        const effect_type = status.system.effect;
        const flat_change = Number(status.system.potency_flat ?? 0);
        const potency     = Number(status.system.potency ?? 1);
        const count       = Number(status.system.count ?? 0);
        const delta       = count * potency + flat_change;
        const sign        = effect_type === "Decrease" ? -1 : 1;
        const minLimit    = Number(status.system.scene_end_effect?.min_resource_limit ?? 0);

        if (status.system.target === "hp" || status.system.target === "hp_stagger") {
          accumulated_hp_delta += delta * sign;
          accumulated_hp_min    = Math.max(accumulated_hp_min, minLimit);
          hp_affected = true;
        }
        if (status.system.target === "stagger" || status.system.target === "hp_stagger") {
          accumulated_stg_delta += delta * sign;
          accumulated_stg_min    = Math.max(accumulated_stg_min, minLimit);
          stg_affected = true;
        }
      }

      // Decrement / clear the count
      if (endOp === "clear") {
        status_updates.push({ _id: status.id, "system.count": 0 });
      } else if (endOp && endOp !== "maintain") {
        const new_count = applyOperator(status.system.count, endOp, status.system.scene_end_effect.variable);
        status_updates.push({ _id: status.id, "system.count": Math.max(new_count, 0) });
      }
    }

    // Apply accumulated resource changes (single write per resource avoids overwrite)
    if (hp_affected) {
      actor_updates["system.health.value"] = Math.max(accumulated_hp_min,
        (actor.system.health.value ?? 0) + accumulated_hp_delta);
    }
    if (stg_affected) {
      actor_updates["system.stagger.value"] = Math.max(accumulated_stg_min,
        (actor.system.stagger.value ?? 0) + accumulated_stg_delta);
    }

    if (status_updates.length) {
      await actor.updateEmbeddedDocuments("Item", status_updates);
    }

    // After expiry updates: recompute expected speed dice and remove any excess clones.
    // Capture speed-dice statuses BEFORE the flush so we can detect which ones were cleared.
    {
      const speed_dice_expired = pre_flush_speed_dice_ids.size > 0 && status_updates.some(u =>
        pre_flush_speed_dice_ids.has(u._id)
      );

      if (speed_dice_expired) {
        // Recompute expected extra after the updates have been applied
        let expected_extra = 0;
        for (const s of actor.items.filter(i =>
          i.type === "status" &&
          i.system?.condition === "passive" &&
          i.system?.target === "number of speed dice" &&
          Number(i.system?.count) > 0
        )) {
          const sign = s.system.effect === "Decrease" ? -1 : 1;
          expected_extra += (Number(s.system.potency_flat ?? 0) + Number(s.system.potency ?? 0) * Number(s.system.count ?? 0)) * sign;
        }
        expected_extra = Math.max(0, expected_extra);

        const base_num_dice  = Number(actor.system.speed_dice?.num_dice ?? 1);
        // expected_total is the total combatant slots needed — base counts as 1, each extra is a clone
        const expected_clones = base_num_dice - 1 + expected_extra;

        const clones = combat.combatants.filter(c =>
          c.actorId === actor.id &&
          c.getFlag("sotc", "isSpeedDieClone")
        );


        if (clones.length > expected_clones) {
          const excess = clones.slice(expected_clones);
          await combat.deleteEmbeddedDocuments("Combatant", excess.map(c => c.id));
        }
      }
    }

    // Compute light_regen_mod inline from statuses — the cached modifiers object
    // was built before this round's status updates, so it may be stale.
    let inline_light_regen_mod = 0;
    for (const s of actor.items.filter(i => i.type === "status" && i.system.condition === "passive" && i.system.target === "light regen" && Number(i.system.count) > 0)) {
      const sign = s.system.effect === "Decrease" ? -1 : 1;
      const flat = Number(s.system.potency_flat ?? 0);
      const pot  = Number(s.system.potency ?? 0);
      const cnt  = Number(s.system.count ?? 0);
      inline_light_regen_mod += (flat + pot * cnt) * sign;
    }

    const light = actor.system.light;
    if (!modifiers.null_light_regen) {
      const current = Number(light.value) || 0;
      const base_regen = Number(light.light_regen) || 0;
      const regen = base_regen + inline_light_regen_mod;
      const max = Number(light.max) || current;

      if (regen !== 0 && current < max) {
        const new_val = Math.min(current + regen, max);
        actor_updates["system.light.value"] = new_val;
      }
    }


    // Merge stagger updates into actor_updates so everything goes in one write
    Object.assign(actor_updates, actor_stag_updates);

    if (Object.keys(actor_updates).length) {
      await game.sotc.updateActor(actor, actor_updates);
    }
  }
  
  if (combatant_updates.length) {
    await combat.updateEmbeddedDocuments("Combatant", combatant_updates);
  }

});


// ─────────────────────────────────────────────────────────────────────────────
//  COMBAT END — restore stagger and/or light based on system settings
// ─────────────────────────────────────────────────────────────────────────────
Hooks.on("deleteCombat", async (combat) => {
  const restoreStagger = game.settings.get("sotc", "restoreStaggerOnCombatEnd");
  const restoreLight   = game.settings.get("sotc", "restoreLightOnCombatEnd");
  if (!restoreStagger && !restoreLight) return;

  // Only the active GM runs this to avoid duplicate updates
  if (!game.user.isGM || !game.users.activeGM?.isSelf) return;

  const processed = new Set();
  const restoredNames = [];

  for (const c of combat.combatants) {
    const actor = c.actor;
    if (!actor) continue;
    if (processed.has(actor.id)) continue;
    processed.add(actor.id);

    const updates = {};

    if (restoreStagger) {
      const max = actor.system.stagger?.max ?? 0;
      if (max > 0) updates["system.stagger.value"] = max;
    }

    if (restoreLight) {
      const max = actor.system.light?.max ?? 0;
      if (max > 0) updates["system.light.value"] = max;
    }

    if (Object.keys(updates).length) {
      await actor.update(updates);
      restoredNames.push(actor.name);
    }
  }

  if (restoredNames.length) {
    const parts = [];
    if (restoreStagger) parts.push("stagger");
    if (restoreLight)   parts.push("light");
    const what = parts.join(" and ");
    ChatMessage.create({
      content: `<div style="background:#12111a; border:1px solid #3a3050; border-radius:6px; padding:10px 12px; font-family:'Signika',sans-serif;">
        <strong style="color:#c9a227;">${game.i18n.localize("SOTC.CombatEnded")}</strong>
        <div style="color:#aaa; font-size:12px; margin-top:4px;">
          ${game.i18n.format("SOTC.CombatRestored", {what, names: restoredNames.join(", ")})}
        </div>
      </div>`
    });
  }
});


// At long last, replacing the previous kind of trash impelementation, we are now hooking our status effects into the default system status effects.
// And hurray! That means that YOU Mr/Mrs. Player can now mark people as prone and unconscious and asleep!
const SOTC_BASE_EFFECTS = new Set([
  "dead",
  "prone",
  "unconscious",
  "sleep"
]);

// Helper that gets our ActiveEffect for a given status effect which we need for rendering our statuses
function getActorStatusEffect(actor, statusId) {
  // Prefer the statusItemId flag (set by our code) over statuses.has() which
  // can miss effects created before the flag was introduced.
  return actor?.effects?.find(e =>
    e.flags?.sotc?.statusItemId === statusId ||
    e.statuses?.has(statusId)
  ) ?? null;
}

// ── Spawn extra speed-die combatant clones for a status mid-combat ──────────
// Called from both createItem (status freshly added with count > 0) and
// updateItem (count goes from 0 → positive).
async function spawnSpeedDiceClones(item, newCount) {
  if (item.system?.condition !== "passive") return;
  if (item.system?.target !== "number of speed dice") return;
  if (!game.combat?.active) return;
  if (newCount <= 0) return;

  const actor = item.actor;
  if (!actor) return;

  const OWNER_LEVEL = 3;
  const designatedOwner = game.users.find(u =>
    !u.isGM && u.active &&
    (actor.ownership[u.id] === OWNER_LEVEL || actor.ownership.default === OWNER_LEVEL)
  );
  if (designatedOwner) {
    if (game.user.id !== designatedOwner.id) return;
  } else {
    if (!game.user.isGM || !game.users.activeGM?.isSelf) return;
  }

  const sign     = item.system.effect === "Decrease" ? -1 : 1;
  const flat     = Number(item.system.potency_flat ?? 0);
  const pot      = Number(item.system.potency ?? 0);
  const extra    = (flat + pot * newCount) * sign;
  const base     = Number(actor.system.speed_dice?.num_dice ?? 1);
  const expected = base + extra;
  const existing = game.combat.combatants.filter(c => c.actorId === actor.id);
  const toCreate = Math.max(0, expected - existing.length);

  if (toCreate <= 0) return;

  const base_combatant = existing.find(c => !c.flags?.sotc?.isSpeedDieClone);
  if (!base_combatant) return;

  const actorFormula = actor.system?.speed_dice?.dice_size ?? CONFIG.Combat.initiative.formula ?? "1d6";

  for (let i = 0; i < toCreate; i++) {
    const cloneIndex = existing.length + i;
    let initiative = null;
    try {
      const roll = await new Roll(actorFormula).evaluate({ async: true });
      initiative = Math.max(1, roll.total);
    } catch(err) {
      console.warn(`sotc | spawnSpeedDiceClones: could not roll initiative for clone:`, err);
    }
    await game.combat.createEmbeddedDocuments("Combatant", [{
      actorId: actor.id,
      tokenId: base_combatant.tokenId,
      hidden: false,
      initiative,
      name: `${base_combatant.name} #${cloneIndex + 1}`,
      flags: { sotc: { isSpeedDieClone: true, speedDieIndex: cloneIndex } }
    }]);
    ui.combat?.render();
  }
}

// Lock set to prevent concurrent syncStatusItemEffect calls for the same item.
// Key is "actorId::itemId" — using a composite prevents cross-actor collisions
// and also covers the createItem -> updateItem double-fire: both share the same
// item.id so the second call is blocked until the first finishes.
const _syncLocks = new Set();

// Helper that correctly gives us our ActiveEffects or obliterates them from existence
async function syncStatusItemEffect(item) {
  if (item.type !== "status") return;
  const actor = item.actor;
  if (!actor) return;

  // Exactly ONE client should run this sync to avoid races that create duplicates.
  // Priority: the actor's designated non-GM owner if they are currently active,
  // otherwise the active GM.
  // "Designated owner" = the first non-GM user in actor.ownership with OWNER level.
  const OWNER_LEVEL = 3;
  const designatedOwner = game.users.find(u =>
    !u.isGM &&
    u.active &&
    (actor.ownership[u.id] === OWNER_LEVEL || actor.ownership.default === OWNER_LEVEL)
  );

  if (designatedOwner) {
    // A player owns this actor and is online — only they should run the sync
    if (game.user.id !== designatedOwner.id) return;
  } else {
    // No online player owner — only the active GM runs it
    const isActiveGM = game.user.isGM && game.users.activeGM?.isSelf;
    if (!isActiveGM) return;
  }

  const lockKey = `${actor.id}::${item.id}`;
  if (_syncLocks.has(lockKey)) return;
  _syncLocks.add(lockKey);

  try {
    const count = Number(item.system?.count ?? 0);

    // Collect ALL effects that belong to this status item (by either lookup method)
    const allMatching = actor.effects.filter(e =>
      e.flags?.sotc?.statusItemId === item.id ||
      e.statuses?.has(item.id)
    );

    // Deduplicate — keep at most one, delete the rest
    if (allMatching.length > 1) {
      const dupeIds = allMatching.slice(1).map(e => e.id).filter(id => {
        // Only delete IDs that still exist on the actor
        return actor.effects.has(id);
      });
      if (dupeIds.length) {
        try {
          await actor.deleteEmbeddedDocuments("ActiveEffect", dupeIds);
        } catch (err) {
          // Another client may have already deleted these — not a problem
          console.warn(`sotc | syncStatusItemEffect: could not delete dupes for ${item.name} on ${actor.name}:`, err.message);
        }
      }
    }

    const existing = allMatching[0] ?? null;

    // Add when needed
    if (count > 0 && !existing) {
      await actor.createEmbeddedDocuments("ActiveEffect", [{
        name: item.name,
        icon: item.img,
        statuses: [item.id],
        origin: item.uuid,
        transfer: false,
        flags: { sotc: { statusItemId: item.id } }
      }]);
      // Redraw badges on all canvas tokens for this actor so counts appear immediately
      canvas.tokens?.placeables
        .filter(t => t.actor?.id === actor.id)
        .forEach(t => requestAnimationFrame(() => t.drawEffects()));
      return;
    }

    // Remove when needed — guard against already-deleted effects
    if (count <= 0 && existing) {
      // Re-check the effect still exists on the actor before deleting
      if (actor.effects.has(existing.id)) {
        try {
          await existing.delete();
        } catch (err) {
          console.warn(`sotc | syncStatusItemEffect: could not delete effect for ${item.name} on ${actor.name}:`, err.message);
        }
      }
    }
  } finally {
    _syncLocks.delete(lockKey);
  }
}

Hooks.once("ready", () => {

  // ── Actor update relay ────────────────────────────────────────────────────
  // Players can't directly update actors they don't own. Instead they create a
  // hidden ChatMessage with a sotc.actorDelta flag. The GM's createChatMessage
  // hook detects it, applies the delta, and deletes the relay message.
  // This works in all Foundry versions without needing socket registration.
  if (game.user.isGM) {
    Hooks.on("createChatMessage", async (message) => {
      const delta = message.getFlag("sotc", "actorDelta");
      if (!delta) return;
      if (!game.users.activeGM?.isSelf) return;

      // Delete the relay message immediately so it doesn't appear in chat
      try { await message.delete(); } catch (e) { /* already deleted */ }

      const actor = game.actors.get(delta.actorId) ??
        canvas.tokens?.placeables?.find(t => t.actor?.id === delta.actorId)?.actor ?? null;

      if (!actor) { console.warn(`sotc | relay: actor ${delta.actorId} not found`); return; }

      const d = delta.delta;
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
  // Old sessions before the GM-only sync guard was added could accumulate duplicate
  // ActiveEffects (one per connected client that raced createEmbeddedDocuments).
  // The active GM cleans these up silently on every world load.
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

  // ── Custom dice sound ───────────────────────────────────────────────────
  CONFIG.sounds.dice = "systems/sotc/assets/audio/speed_dice.mp3";
  console.log("sotc | Custom dice sound registered ✓");

  // ── Socket name (used by updateActor to emit) ─────────────────────────────
  // The listener is registered in the setup hook above to ensure it's ready
  // before any messages arrive.
  const SOCKET_NAME = "system.sotc";

  /**
   * Apply a stat delta to an actor.
   * If the GM: applies directly using fresh actor data.
   * If a player: sends a delta to the GM via socket. The GM recomputes
   * final values from their own fresh copy, preventing stale-value bugs.
   */
  game.sotc.updateActor = async function(actor, delta) {
    if (!actor || !Object.keys(delta ?? {}).length) return;

    const isActiveGM = game.user.isGM && game.users.activeGM?.isSelf;

    // Shared helper — builds absolute update object from delta using provided actor data
    const buildUpdates = (a, d) => {
      const u = {};
      if (d.hp !== undefined)
        u["system.health.value"] = (a.system.health.value ?? 0) + d.hp;
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
      // GM can update any actor; players can update their own actors directly
      const updates = buildUpdates(actor, delta);
      if (Object.keys(updates).length) {
        try { await actor.update(updates); }
        catch (err) { console.error(`sotc | direct update failed for ${actor.name}:`, err); }
      }
    } else {
      // Player updating an actor they don't own — relay via hidden ChatMessage.
      // The GM's createChatMessage hook processes it and applies the delta.
      if (!game.users.activeGM) {
        ui.notifications.warn(game.i18n.localize("SOTC.NotifyNoActiveGM"));
        return;
      }
      await ChatMessage.create({
        content: "",
        whisper: [],
        flags: { sotc: { actorDelta: { actorId: actor.id, delta } } },
        // Prevent this relay message from appearing in chat
        style: CONST.CHAT_MESSAGE_STYLES.OTHER,
        speaker: { alias: "sotc-relay" }
      });
    }
  };


  const TokenHUD = foundry.applications.hud.TokenHUD;
  const originalToggle = TokenHUD.prototype._onToggleEffect;

  TokenHUD.prototype._onToggleEffect = async function (event) {
    const img = event.currentTarget;
    const statusId = img?.dataset?.statusId;
    if (!statusId) return originalToggle.call(this, event);

    const token = this.object;
    const actor = token?.actor;
    if (!actor) return originalToggle.call(this, event);

    // Base statuses are left up to foundry to handle
    if (SOTC_BASE_EFFECTS.has(statusId)) {
      return originalToggle.call(this, event);
    }

    // Yoink, we handle our own custom statuses
    const item = actor.items.get(statusId);
    if (!item || item.type !== "status") {
      return originalToggle.call(this, event);
    }

    // Because we're now handling our statuses, we interrupt Foundry's handling
    event.preventDefault();
    event.stopImmediatePropagation();

    const current = Number(item.system.count ?? 0);
    const isRightClick = event.button === 2;

    // For our stagger_likes we don't need to display a count since they're binary on/off
    if (item.system.condition === "stagger_like") {
      await item.update({ "system.count": current > 0 ? 0 : 1 });
      return;
    }

    // This allows us to decrement/increment the count just by using the status HUD
    if (isRightClick) {
      await item.update({ "system.count": Math.max(current - 1, 0) });
    } else {
      await item.update({ "system.count": current + 1 });
    }
  };

  // What a nightmare this was. I couldn't figure it out so I requested ChatGPT's assistance. It's suboptimal as a dev, but
  // I didn't really have much input here EXCEPT for rigorously durability testing it. 
  // Shared helper — draws count badges onto a token's effect sprites.
  // Extracted so it can be called from both drawEffects and canvasReady.
  function drawCountBadges(token) {
    const actor = token.actor;
    if (!actor || !token.effects) return;

    // Here are the sprites that have been placed previously that we then go backwards from to add the badges to
    const sprites = token.effects.children.filter(c => c.isSprite);
    if (!sprites.length) return;

    // Now go through each of the sprites to add the count badges to them
    for (const effect of actor.effects) {
      const statusId = effect.flags?.sotc?.statusItemId;
      if (!statusId) continue;

      const item = actor.items.get(statusId);
      if (!item || item.type !== "status") continue;
      if (item.system.condition === "stagger_like") continue;

      const count = Number(item.system.count ?? 0);
      if (count <= 0) continue;

      // Find matching sprite by icon path, endsWith is critical according to ChatGPT but I don't really parse the magic here
      const sprite = sprites.find(s => {
        const src = s.texture?.baseTexture?.resource?.src;
        return src && src.includes((effect.img ?? effect.icon ?? "").split("/").pop());
      });

      if (!sprite) continue;

      // Remove an old badge if it exists
      for (const child of [...sprite.children]) {
        if (child.name === "sotc-count") sprite.removeChild(child);
      }

      // Get the bounds of the sprite so that we appropriately size the elements of the badge according to how big the scene is
      // This should be better behaved then the previous status effect handler as far as grid sizes go.
      const bounds = sprite.getLocalBounds();

      const badge = new PIXI.Text(String(count), {
        fontSize: Math.floor(bounds.width * 0.4),
        fill: 0xffffff,
        stroke: 0x000000,
        strokeThickness: 4,
        fontWeight: "900"
      });

      badge.name = "sotc-count";
      badge.anchor.set(1, 1);
      badge.position.set(bounds.width, bounds.height);

      sprite.addChild(badge);
    }
  }

  const Token = foundry.canvas.placeables.Token;
  const originalDrawEffects = Token.prototype.drawEffects;
  Token.prototype.drawEffects = async function (...args) {
    await originalDrawEffects.apply(this, args);

    // Capture reference — 'this' is not safe inside the rAF callback
    const token = this;

    // Yield one frame for Foundry to finish placing sprites, then badge synchronously
    requestAnimationFrame(() => drawCountBadges(token));
  };
});

// On F5, drawEffects fires before textures and ActiveEffects are fully ready.
// Wait 500ms after canvasReady to ensure everything is loaded, then redraw all badges.
Hooks.on("canvasReady", () => {
  setTimeout(() => {
    for (const token of canvas.tokens.placeables) {
      token.drawEffects();
    }
  }, 500);
});

Hooks.on("renderTokenHUD", (hud, html, data) => {
  const el = html instanceof HTMLElement ? html : html[0];

  // Foundry tries really hard to update everything and RUIN my LIFE before I'm able to do what I need to do
  // So we wait, and then we go
  requestAnimationFrame(() => {
    const effectsButton = el.querySelector('[data-action="effects"]');
    if (!effectsButton) return;

    const effectsPanel = effectsButton.querySelector(".status-effects");
    if (!effectsPanel) return;

    const token = canvas.tokens.get(data._id);
    const actor = token?.actor;
    if (!actor) return;

    effectsPanel.innerHTML = "";

    // The actual actor status effects now that we waited
    const activeStatuses = new Set();
    for (const effect of actor.effects.contents) {
      if (!effect.statuses) continue;
      for (const id of effect.statuses) activeStatuses.add(id);
    }

    // Base effects
    for (const eff of CONFIG.statusEffects) {
      if (!SOTC_BASE_EFFECTS.has(eff.id)) continue;

      const img = document.createElement("img");
      img.classList.add("effect-control");
      img.src = eff.icon;
      img.title = eff.label;
      img.dataset.statusId = eff.id;

      if (activeStatuses.has(eff.id)) {
        img.classList.add("active");
      }

      effectsPanel.appendChild(img);
    }

    // Custom status items
    const statusItems = actor.items.filter(i => i.type === "status");
    for (const item of statusItems) {
      const img = document.createElement("img");
      img.classList.add("effect-control");
      img.src = item.img;
      img.title = item.name;
      img.dataset.statusId = item.id;

      if (activeStatuses.has(item.id)) {
        img.classList.add("active");
      }

      effectsPanel.appendChild(img);
    }
  });
});


// ── Safeguard notification ──────────────────────────────────────────────────
// Shared helper — only the active GM runs this to avoid duplicate messages.
async function _notifySafeguard(actor, item, newCount) {
  // Only the active GM creates the prompt message — avoids duplicates across clients.
  if (!game.user.isGM || !game.users.activeGM?.isSelf) return;

  const safeguard = actor.items.find(i =>
    i.type === "status" &&
    i.name.toLowerCase() === "safeguard" &&
    Number(i.system?.count ?? 0) > 0
  );
  if (!safeguard) return;

  const sgCount = Number(safeguard.system.count);
  const statusType = item.system?.types ?? "status";
  const OWNER_LEVEL = 3;

  // Whisper to active owners + all GMs so everyone relevant sees it
  const whisperTo = game.users.filter(u =>
    u.active && (
      u.isGM ||
      actor.ownership[u.id] === OWNER_LEVEL ||
      actor.ownership.default === OWNER_LEVEL
    )
  );

  const sgIcon = `<img src="systems/sotc/assets/statuses/Safeguard.png" style="width:20px;height:20px;border:none;vertical-align:middle;margin-right:5px;">`;
  const statusIcon = item.img ? `<img src="${item.img}" style="width:16px;height:16px;border:none;vertical-align:middle;margin-right:4px;">` : "";

  await ChatMessage.create({
    content: `
      <div style="font-family:'Signika',sans-serif;background:#12111a;border:1px solid #2a5040;border-radius:6px;padding:10px 12px;">
        <div style="color:#4caf7d;font-weight:700;font-size:13px;margin-bottom:8px;">${sgIcon}${game.i18n.format("SOTC.SafeguardTitle", {actor: actor.name})}</div>
        <div style="color:#ccc;font-size:12px;margin-bottom:10px;">
          ${statusIcon}<b style="color:#e8d9a0;">${item.name}</b> ${game.i18n.format("SOTC.SafeguardApplied", {type: statusType, count: newCount})}
          <br>${game.i18n.format("SOTC.SafeguardSpend", {from: sgCount, to: sgCount - 1})}
        </div>
        <div style="display:flex;gap:8px;">
          <button class="sotc-safeguard-yes"
            data-actor-id="${actor.id}"
            data-safeguard-id="${safeguard.id}"
            data-sg-count="${sgCount}"
            style="flex:1;background:#2a5040;color:#aee8c8;border:1px solid #3a7060;border-radius:4px;padding:4px 8px;cursor:pointer;">
            <i class="fas fa-shield-alt"></i> ${game.i18n.localize("SOTC.ButtonSpendSafeguard")}
          </button>
          <button class="sotc-safeguard-no"
            style="flex:1;background:#3a2020;color:#e8a0a0;border:1px solid #6a3030;border-radius:4px;padding:4px 8px;cursor:pointer;">
            <i class="fas fa-times"></i> ${game.i18n.localize("SOTC.ButtonIgnore")}
          </button>
        </div>
      </div>`,
    whisper: whisperTo,
    speaker: { alias: actor.name },
    flags: { sotc: { safeguardPromptActorId: actor.id } }
  });
}

// Track previous counts so updateItem can detect 0 → positive transitions.
const _safeguardPrevCounts = new Map();

Hooks.on("preUpdateItem", (item, changes) => {
  if (item.type !== "status") return;
  if (!["debuff", "ailment"].includes(item.system?.types)) return;
  if (changes.system?.count === undefined) return;
  _safeguardPrevCounts.set(item.id, Number(item.system?.count ?? 0));
});

// Fires when a brand-new debuff/ailment is added to an actor with count > 0.
Hooks.on("createItem", async (item) => {
  if (item.type !== "status") return;
  const actor = item.actor;
  if (!actor) return;
  if (!["debuff", "ailment"].includes(item.system?.types)) return;
  const count = Number(item.system?.count ?? 0);
  if (count <= 0) return;
  await _notifySafeguard(actor, item, count);
});

// Relevent only to our status effects, not any of the other items that may be created. Since our helper only does anything for statuses, we can call this senselessly
Hooks.on("createItem", async (item) => {
  await syncStatusItemEffect(item);
  // If a speed-dice status is freshly added with count > 0, spawn clones immediately
  if (item.type === "status") {
    const count = Number(item.system?.count ?? 0);
    if (count > 0) await spawnSpeedDiceClones(item, count);
  }
});

Hooks.on("updateItem", async (item, changes) => {
  if (item.type !== "status") return;

  const countChanged = changes.system?.count !== undefined;

  // ── Safeguard notification on count update ──
  // Fires when a debuff/ailment goes from 0 → positive count.
  // Uses _safeguardPrevCounts (set by preUpdateItem) for the true previous value,
  // since item.system.count is already the new value by the time updateItem fires.
  if (countChanged) {
    const newCount = Number(changes.system.count);
    const prevCount = _safeguardPrevCounts.get(item.id) ?? Number(item.system?.count ?? 0);
    _safeguardPrevCounts.delete(item.id);
    const actor = item.actor;
    if (newCount > prevCount && newCount > 0 && actor &&
        ["debuff", "ailment"].includes(item.system?.types)) {
      await _notifySafeguard(actor, item, newCount);
    }
  }

  // Clear stagger_end when use_duration is toggled off
  if (changes.system?.use_duration === false && Number(item.system.stagger_end ?? 0) > 0) {
    await item.update({ "system.stagger_end": null }, { diff: true });
  }

  if (countChanged) {
    const newCount  = Number(changes.system.count);
    const condition = item.system.condition;
    const use_duration   = item.system.use_duration ?? false;
    const duration       = Number(item.system.stagger_duration ?? 0);
    const alreadyStamped = Number(item.system.stagger_end ?? 0) > 0;

    // Stamp stagger_end only when use_duration is enabled and for passive/stagger_like.
    // Active conditions use scene_end_effect to count down — stamping them
    // causes hard-wipe instead of ticking (the Burn bug).
    if (use_duration && newCount > 0 && duration > 0 && !alreadyStamped &&
        (condition === "passive" || condition === "stagger_like")) {
      const applied_round = game.combat?.round ?? 0;
      const end_round = applied_round + duration;
      await item.update({ "system.stagger_end": end_round }, { diff: true });
      // Don't return — fall through so speed dice clones can still be spawned below
    }

    // If this is a speed-dice status going from 0 → positive mid-combat, spawn clones now.
    if (newCount > 0) {
      await spawnSpeedDiceClones(item, newCount);
    } else if (
      newCount <= 0 &&
      item.system?.condition === "passive" &&
      item.system?.target === "number of speed dice" &&
      game.combat?.active &&
      // Only one client should delete — GM if no active player owner, else designated owner
      (() => {
        const a = item.actor;
        if (!a) return false;
        const OWNER_LEVEL = 3;
        const owner = game.users.find(u => !u.isGM && u.active && (a.ownership[u.id] === OWNER_LEVEL || a.ownership.default === OWNER_LEVEL));
        return owner ? game.user.id === owner.id : (game.user.isGM && game.users.activeGM?.isSelf);
      })()
    ) {
      // Status cleared — remove excess clone combatants for this actor
      const actor = item.actor;
      if (actor) {
        // Recount expected extra from remaining active speed-dice statuses (excluding this one)
        let expected_extra = 0;
        for (const s of actor.items.filter(i =>
          i.type === "status" && i.id !== item.id &&
          i.system?.condition === "passive" &&
          i.system?.target === "number of speed dice" &&
          Number(i.system?.count) > 0
        )) {
          const sign = s.system.effect === "Decrease" ? -1 : 1;
          expected_extra += (Number(s.system.potency_flat ?? 0) + Number(s.system.potency ?? 0) * Number(s.system.count ?? 0)) * sign;
        }
        expected_extra = Math.max(0, expected_extra);
        const base_num_dice = Number(actor.system.speed_dice?.num_dice ?? 1);
        const expected_clones = base_num_dice - 1 + expected_extra;
        const clones = game.combat.combatants.filter(c =>
          c.actorId === actor.id && c.getFlag("sotc", "isSpeedDieClone")
        );
        if (clones.length > expected_clones) {
          const excess = clones.slice(expected_clones);
          const validIds = excess.map(c => c.id).filter(id => game.combat.combatants.has(id));
          if (validIds.length && game.user.isGM && game.users.activeGM?.isSelf) {
            await game.combat.deleteEmbeddedDocuments("Combatant", validIds).catch(() => {});
          }
        }
      }
    }
  }

  await syncStatusItemEffect(item);
});

// If we delete something, we want to make sure it doesn't get permanently stuck rendering. That'd be real awkward
Hooks.on("deleteItem", async (item) => {
  if (item.type !== "status") return;
  const actor = item.actor;
  if (!actor) return;

  // Same single-client guard as syncStatusItemEffect
  const OWNER_LEVEL = 3;
  const designatedOwner = game.users.find(u =>
    !u.isGM &&
    u.active &&
    (actor.ownership[u.id] === OWNER_LEVEL || actor.ownership.default === OWNER_LEVEL)
  );
  if (designatedOwner) {
    if (game.user.id !== designatedOwner.id) return;
  } else {
    const isActiveGM = game.user.isGM && game.users.activeGM?.isSelf;
    if (!isActiveGM) return;
  }

  const effect = getActorStatusEffect(actor, item.id);
  if (effect && actor.effects.has(effect.id)) {
    try {
      await effect.delete();
    } catch (err) {
      console.warn(`sotc | deleteItem: could not delete effect for ${item.name}:`, err.message);
    }
  }

  // If this was a speed-dice status, remove any clones it granted
  // Only the designated owner or active GM should do this — same guard as above
  if (
    item.system?.condition === "passive" &&
    item.system?.target === "number of speed dice" &&
    game.combat?.active &&
    (designatedOwner ? game.user.id === designatedOwner.id : (game.user.isGM && game.users.activeGM?.isSelf))
  ) {
    let expected_extra = 0;
    for (const s of actor.items.filter(i =>
      i.type === "status" && i.id !== item.id &&
      i.system?.condition === "passive" &&
      i.system?.target === "number of speed dice" &&
      Number(i.system?.count) > 0
    )) {
      const sign = s.system.effect === "Decrease" ? -1 : 1;
      expected_extra += (Number(s.system.potency_flat ?? 0) + Number(s.system.potency ?? 0) * Number(s.system.count ?? 0)) * sign;
    }
    expected_extra = Math.max(0, expected_extra);
    const base_num_dice = Number(actor.system.speed_dice?.num_dice ?? 1);
    const expected_clones = base_num_dice - 1 + expected_extra;
    const clones = game.combat.combatants.filter(c =>
      c.actorId === actor.id && c.getFlag("sotc", "isSpeedDieClone")
    );
    if (clones.length > expected_clones) {
      const excess = clones.slice(expected_clones);
      const validIds = excess.map(c => c.id).filter(id => game.combat.combatants.has(id));
      if (validIds.length && game.user.isGM && game.users.activeGM?.isSelf) {
        await game.combat.deleteEmbeddedDocuments("Combatant", validIds).catch(() => {});
      }
    }
  }
});


// When a token is freshly dropped onto the canvas, drawEffects fires before the actor's
// ActiveEffects are fully synced, so badges don't appear. We wait a tick then force a redraw.
Hooks.on("createToken", async (tokenDoc, options, userId) => {
  // Only act for the client that placed the token
  if (game.user.id !== userId) return;

  // Give Foundry time to finish creating embedded ActiveEffects on the new actor
  await new Promise(r => setTimeout(r, 300));

  const token = tokenDoc.object;
  if (token) token.drawEffects();
});

Hooks.on("createActor", async (actor, options, userId) => {
  // Load the compendium
  const pack = game.packs.get("sotc.default-statuses");
  if (!pack) {
    console.error("SotC | Default statuses compendium not found.");
    return;
  }

  // Get all documents from the compendium
  const statuses = await pack.getDocuments();

  // Make sure they are Items
  const items = statuses.map(s => s.toObject());

  // Apply per-status defaults that ideally live in the compendium item data.
  // For Sinking specifically:
  //   - scene_end_effect.min_resource_limit = 1  (round-end halving never reduces to 0)
  //   - post_actives: "Trigger then Divide By" entries get min_resource_limit = 1
  //     (manual divide trigger also shouldn't reduce to 0)
  //   - post_actives: "Trigger (Sinking) Deluge" entry stays at 0 so it can fully
  //     drain stagger as part of its overflow-damage calculation.
  for (const item of items) {
    if (!item.system) continue;
    const nameLower = (item.name ?? "").toLowerCase();

    // ── Sinking: halving should never reduce stagger below 1 ──
    if (nameLower === "sinking") {
      const sce = item.system.scene_end_effect;
      if (sce && (sce.min_resource_limit == null)) {
        item.system.scene_end_effect = { ...sce, min_resource_limit: 1 };
      }
      const raw_pa = item.system.post_actives;
      if (raw_pa) {
        const pa_arr = Array.isArray(raw_pa) ? raw_pa : Object.values(raw_pa);
        item.system.post_actives = pa_arr.map(pa => {
          if (pa.operator === "sinking_deluge") return pa; // Deluge stays at 0
          if (pa.min_resource_limit == null) return { ...pa, min_resource_limit: 1 };
          return pa;
        });
      }
    }

    // ── Thorns: default special_trigger and condition ──
    if (nameLower === "thorns") {
      if (!item.system.special_trigger) {
        item.system.special_trigger = "on_receive_damage";
      }
      if (!item.system.condition) {
        item.system.condition = "special";
      }
    }
  }

  // Create them on the actor (skip if actor already has items with the same name)
  await actor.createEmbeddedDocuments("Item", items.filter(item =>
    !actor.items.some(ai => ai.name === item.name)
  ));
});

Hooks.on("renderChatMessage", (message, html) => {

  // ── Clash group card — collapse toggle ───────────────────────────────────
  const toggle = html.find(".sotc-clash-toggle")[0];
  if (toggle) {
    const rows  = html.find(".sotc-clash-rows")[0];
    const chev  = html.find(".sotc-clash-chevron")[0];
    // Restore collapsed state from data attribute (set when card was updated)
    if (rows?.dataset?.collapsed === "true") {
      rows.style.display = "none";
      if (chev) chev.style.transform = "rotate(-90deg)";
    }
    toggle.addEventListener("click", () => {
      const collapsed = rows.style.display === "none";
      rows.style.display = collapsed ? "" : "none";
      if (chev) chev.style.transform = collapsed ? "" : "rotate(-90deg)";
    });
  }

  // ── Initiative group card — collapse toggle ──────────────────────────────
  const initToggle = html.find(".sotc-init-toggle")[0];
  if (initToggle) {
    const initRows = html.find(".sotc-init-rows")[0];
    const initChev = html.find(".sotc-init-chevron")[0];
    if (initRows?.dataset?.collapsed === "true") {
      initRows.style.display = "none";
      if (initChev) initChev.style.transform = "rotate(-90deg)";
    }
    initToggle.addEventListener("click", () => {
      const collapsed = initRows.style.display === "none";
      initRows.style.display = collapsed ? "" : "none";
      if (initChev) initChev.style.transform = collapsed ? "" : "rotate(-90deg)";
    });
  }

  // ── Safeguard yes/no buttons ──────────────────────────────────────────────
  html.find(".sotc-safeguard-yes").on("click", async ev => {
    ev.preventDefault();
    const btn = ev.currentTarget;
    const actorId     = btn.dataset.actorId;
    const safeguardId = btn.dataset.safeguardId;
    const sgCount     = Number(btn.dataset.sgCount);

    const actor     = game.actors.get(actorId);
    const safeguard = actor?.items.get(safeguardId);
    if (safeguard) {
      await safeguard.update({ "system.count": Math.max(0, sgCount - 1) });
    }
    try { await message.delete(); } catch(e) {}
  });

  html.find(".sotc-safeguard-no").on("click", async ev => {
    ev.preventDefault();
    try { await message.delete(); } catch(e) {}
  });

  html.find(".reroll-die").on("click", async ev => {
    ev.preventDefault();
    const btn = ev.currentTarget;

    const item_name = btn.dataset.itemname || game.i18n.localize("SOTC.UnknownItem");
    const formula = btn.dataset.formula;
    const mod = btn.dataset.mod;
    const status_mod = btn.dataset.statmod;
    let total = formula
    if (mod !== 0) {
      total = `${total}+${mod}`;
    }
    if (status_mod !== 0) {
      total = `${total}+${status_mod}`;
    }
    const type = btn.dataset.type;
    const colorClass = btn.dataset.color;
    let modules;
    try {
      modules = JSON.parse(btn.dataset.modules || "[]");
      if (!Array.isArray(modules)) modules = [];
    } catch {
      modules = [];
    }



    try {
      const roll = await (new Roll(total)).roll({ async: true });

      const icon = `systems/sotc/assets/dice types/${type}.png`;
      const moduleLine = modules.length
        ? `<div style="margin-top: 4px; font-size: 12px;"><em>${
            modules.map(m => `<div style="margin-left: 5px; margin-bottom:2px;">• ${enrichModWithStatusIcons(m, game.actors.get(message.speaker?.actor))}</div>`).join("")
          }</em></div>`
        : "";

      const payload = {
        dieType: type,
        total: roll.total,
        itemName: item_name,
        formula: formula,
        isOffensive: ["slash","pierce","blunt","counter-slash","counter-pierce","counter-blunt"].includes(type),
        isDefensive: ["block","evade","counter-block","counter-evade"].includes(type),
        actorId: message.speaker?.actor ?? ChatMessage.getSpeaker()?.actor ?? null
      };

      const messageContent = `
        <div class="skill-die-roll">
          <h3>${game.i18n.format("SOTC.RerollTitle", {item: item_name, type})}</h3>
          <div style="margin-left:5px;margin-bottom:5px;">
            <span class="${colorClass}" style="margin-left: 5px; vertical-align: middle; font-size: 16px;">
              <div style="display: flex; gap: 4px;">
                <img src="${icon}" alt="${type}" style="height: 30px; width: 30px; vertical-align: middle; border: none;">
                <strong style="text-shadow: black 0.5px 0.5px; margin-top: 4px;">${total} = ${roll.total}</strong>
                <a class="reroll-die"
                  data-formula="${formula}"
                  data-type="${type}"
                  data-mod="${mod}"
                  data-statmod="${status_mod}"
                  data-color="${colorClass}"
                  data-modules='${JSON.stringify(modules)}'
                  data-itemname="${item_name}"
                  title="${game.i18n.localize("SOTC.RollSkillRerollDie")}" 
                  style="width: 16px; height: 16px; color: black; margin-top: 4px; margin-left: 8px;">
                  <i class="fas fa-rotate-left"></i>
                </a>
                <a class="resolve-die"
                  title="${game.i18n.localize("SOTC.RollSkillApplyDie")}"
                  data-payload='${JSON.stringify(payload)}'
                  style="width: 16px; height: 16px; color: black; margin-left: 8px; margin-top: 4px;">
                  <i class="fas fa-bolt"></i>
                </a>
              </div>
            </span>
            ${moduleLine ? `${moduleLine}` : ""}
          </div>
        </div>
      `;

      await roll.toMessage({
        speaker: ChatMessage.getSpeaker(),
        flavor: messageContent,
        sound: CONFIG.sounds.dice
      });

    } catch (err) {
      console.error("Reroll failed:", err);
      ui.notifications.error(game.i18n.localize("SOTC.NotifyCouldNotReroll"));
    }
  });

  // Everything below this point should REALLY be in a separate .js document. I did this here because I could not be fucked to move it over
  // It is sunday, at 2:25 am and I feel like that one guy who did some songs for furi who names his tracks after the time when he finishes them
  // which is to say... fulfilled? I'm basically there and just reviewing code at this point...
  // But I kind of want to explode...
  html.find(".resolve-die").on("click", ev => {
    const payload = JSON.parse(ev.currentTarget.dataset.payload);
    payload.sourceMessageId = message.id;
    openDamageWizard(payload); // token is resolved inside from game.user.targets
  });

  // ── Undo button (emitted by resolveDamage into chat) ───────────────────
  html.find(".sotc-undo-damage").on("click", async ev => {
    ev.preventDefault();
    const btn = ev.currentTarget;

    // Guard: only allow undo once per button
    if (btn.dataset.undone === "1") return;
    btn.dataset.undone = "1";
    btn.style.opacity      = "0.4";
    btn.style.pointerEvents = "none";
    btn.innerHTML = `<i class="fas fa-check"></i> ${game.i18n.localize("SOTC.ButtonUndone")}`;

    let snapshot;
    try {
      snapshot = JSON.parse(btn.dataset.snapshot);
    } catch(e) {
      return ui.notifications.error(game.i18n.localize("SOTC.NotifyUndoFailed"));
    }

    const restoreActor = async (snap) => {
      if (!snap) return;
      // Prefer resolving through the canvas token so synthetic/unlinked actors
      // are updated on the right document, not the base world actor.
      const actor = (snap.tokenId ? canvas.tokens?.get(snap.tokenId)?.actor : null)
                 ?? game.actors.get(snap.actorId);
      if (!actor) return;
      await game.sotc.updateActor(actor, {
        "system.health.value":  snap.hp,
        "system.stagger.value": snap.stagger,
      });
    };

    await restoreActor(snapshot.target);
    await restoreActor(snapshot.attacker);

    ui.notifications.info(game.i18n.localize("SOTC.NotifyDamageUndone"));
  });

  // ── Apply status from chat mod line [+] button ──────────────────────────
  html.find(".apply-status-from-chat").on("click", async ev => {
    ev.preventDefault();
    const statusName = ev.currentTarget.dataset.statusName;
    const rawCount   = ev.currentTarget.dataset.statusCount;

    // Resolve source status: check the speaking actor's items first, then world items
    const speakerActorId = message.speaker?.actor;
    const speakerActor = speakerActorId ? game.actors.get(speakerActorId) : null;

    const sourceStatus =
      speakerActor?.items.find(i => i.type === "status" && i.name.toLowerCase() === statusName) ??
      game.items.find(i => i.type === "status" && i.name.toLowerCase() === statusName);

    if (!sourceStatus) {
      return ui.notifications.warn(game.i18n.format("SOTC.NotifyNoStatusItem", {name: statusName}));
    }

    const targets = [...game.user.targets];
    if (!targets.length) {
      return ui.notifications.warn(game.i18n.localize("SOTC.NotifyNoTarget"));
    }

    // Determine how many stacks to apply
    let stacksToAdd;
    if (rawCount && Number(rawCount) > 0) {
      // Number was detected right before the status name — use it directly, no dialog
      stacksToAdd = Number(rawCount);
    } else {
      // No number found — ask the user
      stacksToAdd = await new Promise(resolve => {
        new Dialog({
          title: game.i18n.format("SOTC.ApplyStatusTitle", {name: sourceStatus.name}),
          content: `
            <div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
              <label style="flex-shrink:0;">${game.i18n.localize("SOTC.ApplyStatusStacks")}</label>
              <input id="sotc-stack-input" type="number" min="1" value="1"
                style="width:60px;" autofocus />
            </div>`,
          buttons: {
            apply: {
              icon: '<i class="fas fa-check"></i>',
              label: game.i18n.localize("SOTC.ButtonApply"),
              callback: html => {
                const val = Number(html.find("#sotc-stack-input").val());
                resolve(val > 0 ? val : 1);
              }
            },
            cancel: {
              icon: '<i class="fas fa-times"></i>',
              label: game.i18n.localize("SOTC.ButtonCancel"),
              callback: () => resolve(null)
            }
          },
          default: "apply"
        }).render({ force: true });
      });
    }

    if (!stacksToAdd) return; // user cancelled

    for (const target of targets) {
      const targetActor = target.actor;
      if (!targetActor) continue;

      const existing = targetActor.items.find(i => i.type === "status" && i.name === sourceStatus.name);
      if (existing) {
        const newCount = (Number(existing.system.count) || 0) + stacksToAdd;
        await existing.update({ "system.count": newCount });
        ui.notifications.info(game.i18n.format("SOTC.NotifyStatusStacks", {status: sourceStatus.name, actor: targetActor.name, count: newCount}));
      } else {
        const newItem = sourceStatus.toObject();
        newItem.system.count = stacksToAdd;
        await targetActor.createEmbeddedDocuments("Item", [newItem]);
        ui.notifications.info(game.i18n.format("SOTC.NotifyStatusApplied", {stacks: stacksToAdd, status: sourceStatus.name, actor: targetActor.name}));
      }
    }
  });
});


// ─────────────────────────────────────────────────────────────────────────────
//  DAMAGE WIZARD
//
//  Clash result AUTO-DETECTED from rolls:
//    defender = 0         → Unopposed
//    attacker > defender  → Clash Win
//    attacker = defender  → Clash Tie
//    attacker < defender  → Clash Lose
//
//  Clash Lose applies damage TO THE ATTACKER (who lost):
//    Offensive [Lose vs Offensive] → attacker takes damage+stagger = defender's roll
//    Block     [Lose vs Offensive] → attacker takes net = defender - block power
//    Evade     [Lose vs Offensive] → attacker takes net stagger = defender - evade power
//
//  All actor updates go through game.sotc.updateActor so players can apply
//  damage to tokens they don't own (proxied through the GM via socket).
// ─────────────────────────────────────────────────────────────────────────────

/** Strip "counter-" prefix so logic works for both regular and counter dice. */
function normaliseType(t) {
  return (t || "").replace(/^counter-/, "");
}

function isOffensiveType(t) {
  return ["slash", "pierce", "blunt"].includes(normaliseType(t));
}

function isDefensiveType(t) {
  return ["block", "evade"].includes(normaliseType(t));
}

/**
 * Resolve the attacker actor from payload.actorId.
 * Falls back to the first controlled token if missing.
 * NOTE: also set actorId in skill-sheet.js when building the initial roll payload.
 */
function resolveAttackerActor(payload) {
  if (payload.actorId) {
    const a = game.actors.get(payload.actorId);
    if (a) return a;
  }
  return canvas.tokens?.controlled?.[0]?.actor ?? null;
}

/**
 * Apply slash/pierce/blunt affinity modifiers to a base damage and stagger value.
 * Returns [finalDamage, finalStagger].
 */
function applyAffinities(actor, dieBase, baseDmg, baseStagger) {
  const m = actor.system.modifiers;
  if (dieBase === "slash") {
    return [
      Math.max(0, baseDmg     + (m.slash_damage_affinity  ?? 0)),
      Math.max(0, baseStagger + (m.slash_stagger_affinity ?? 0))
    ];
  } else if (dieBase === "pierce") {
    return [
      Math.max(0, baseDmg     + (m.pierce_damage_affinity  ?? 0)),
      Math.max(0, baseStagger + (m.pierce_stagger_affinity ?? 0))
    ];
  } else {
    return [
      Math.max(0, baseDmg     + (m.blunt_damage_affinity  ?? 0)),
      Math.max(0, baseStagger + (m.blunt_stagger_affinity ?? 0))
    ];
  }
}

/**
 * Apply stat changes to an actor. Routes through game.sotc.updateActor
 * so players can affect tokens they don't own (GM proxies via socket).
 *   dmg         > 0  → removes HP
 *   stagger     > 0  → removes stagger
 *   staggerGain > 0  → restores stagger
 */
async function applyStats(actor, { dmg = 0, stagger = 0, staggerGain = 0 } = {}) {
  if (!dmg && !stagger && !staggerGain) return;

  // Send deltas — the receiver computes absolute values from fresh actor data,
  // preventing stale-value bugs when the player's local copy is out of sync.
  const delta = {};
  if (dmg        > 0) delta.hp          = -dmg;
  if (stagger    > 0) delta.stagger     = -stagger;
  if (staggerGain > 0) delta.staggerGain = staggerGain;

  await game.sotc.updateActor(actor, delta);
}

/**
 * Build and open the Damage Wizard dialog.
 * Opposing die type is chosen via one-click icon buttons (no dropdown).
 */
async function openDamageWizard(payload) {
  // Check permission — players need the setting enabled to use the wizard
  if (!game.user.isGM && !game.settings.get("sotc", "playerDamageWizard")) {
    return ui.notifications.warn(game.i18n.localize("SOTC.NotifyDamageWizardGMOnly"));
  }

  const targets = Array.from(game.user.targets);
  if (!targets.length) {
    return ui.notifications.warn(game.i18n.localize("SOTC.NotifySelectTarget"));
  }

  const token   = targets[0];
  const dieBase = normaliseType(payload.dieType);

  const badgeColor = isOffensiveType(dieBase) ? "#7a1a1a"
                   : dieBase === "block"       ? "#1a3f7a"
                   :                             "#1a5e35";

  const dieButtons = [
    { value: "none",   label: game.i18n.localize("SOTC.DieNone"),   icon: null,                                          color: "#444"    },
    { value: "slash",  label: game.i18n.localize("SOTC.DieSlash"),  icon: "systems/sotc/assets/dice types/slash.png",   color: "#8b1a1a" },
    { value: "pierce", label: game.i18n.localize("SOTC.DiePierce"), icon: "systems/sotc/assets/dice types/pierce.png",  color: "#7a3a00" },
    { value: "blunt",  label: game.i18n.localize("SOTC.DieBlunt"),  icon: "systems/sotc/assets/dice types/blunt.png",   color: "#5a4a00" },
    { value: "block",  label: game.i18n.localize("SOTC.DieBlock"),  icon: "systems/sotc/assets/dice types/block.png",   color: "#1a3f7a" },
    { value: "evade",  label: game.i18n.localize("SOTC.DieEvade"),  icon: "systems/sotc/assets/dice types/evade.png",   color: "#1a5e35" },
  ];

  const btnHTML = dieButtons.map((b, i) => `
    <button type="button"
      class="sotc-die-btn"
      data-value="${b.value}"
      data-accent="${b.color}"
      style="
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        gap:4px; padding:6px 4px; border-radius:6px; cursor:pointer;
        border:2px solid ${i === 0 ? b.color : "transparent"};
        background:${i === 0 ? b.color + "33" : "#1e1b2e"};
        color:${i === 0 ? "#fff" : "#aaa"};
        font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em;
        flex:1; min-width:0;
      "
      onclick="
        this.closest('.sotc-wizard-wrap').querySelectorAll('.sotc-die-btn').forEach(el => {
          el.style.borderColor = 'transparent';
          el.style.background  = '#1e1b2e';
          el.style.color       = '#aaa';
        });
        this.style.borderColor = this.dataset.accent;
        this.style.background  = this.dataset.accent + '33';
        this.style.color       = '#fff';
        this.closest('.sotc-wizard-wrap').querySelector('[name=defender_die_type]').value = this.dataset.value;
      "
    >
      ${b.icon
        ? `<img src="${b.icon}" style="width:28px;height:28px;border:none;object-fit:contain;" />`
        : `<span style="font-size:18px;line-height:28px;color:#888;">✕</span>`
      }
      ${b.label}
    </button>
  `).join("");

  const INPUT_STYLE = `background:#f5f0e8; color:#1a1a1a; border:1px solid #8a7a5a; border-radius:4px; padding:5px 8px; width:100%; box-sizing:border-box; font-size:14px; margin-top:3px;`;
  const LABEL_STYLE = `display:block; font-weight:600; color:#c9a227; font-size:11px; text-transform:uppercase; letter-spacing:0.06em; margin-top:10px;`;

  // Detect Thorns on target and Bleed on attacker for conditional checkboxes.
  // Build the HTML strings up-front (no nested template literals).
  const _isOff = isOffensiveType(normaliseType(payload.dieType));
  const _tActor = token.actor;
  const _aActor = resolveAttackerActor(payload);
  const _thornsItem = _isOff ? _tActor?.items.find(i =>
    i.type === "status" && i.system?.condition === "special" &&
    i.system?.special_trigger === "on_receive_damage" && Number(i.system?.count ?? 0) > 0
  ) : null;
  const _bleedItem = _isOff ? _aActor?.items.find(i =>
    i.type === "status" && i.name.toLowerCase() === "bleed" && Number(i.system?.count ?? 0) > 0
  ) : null;
  const _thornCount = _thornsItem ? Number(_thornsItem.system.count) : 0;
  const _bleedCount = _bleedItem  ? Number(_bleedItem.system.count)  : 0;

  const critCheckboxHtml = _thornsItem ? [
    '<label style="' + LABEL_STYLE + ' flex-direction:row; align-items:center; gap:8px; margin-top:10px;">',
    '  <input type="checkbox" name="is_crit" style="width:16px; height:16px; cursor:pointer; margin:0;" />',
    '  <span>' + game.i18n.localize("SOTC.DamageWizardCritHit") + '',
    '    <span style="font-weight:400; color:#888; font-size:10px;">',
    '      <img src="' + (_thornsItem.img || 'systems/sotc/assets/statuses/Thorns.png') + '"',
    '           style="width:12px;height:12px;border:none;object-fit:contain;vertical-align:middle;margin-right:2px;">',
    '      ' + game.i18n.format("SOTC.DamageWizardCritThorns", {count: _thornCount}),
    '    </span>',
    '  </span>',
    '</label>',
  ].join("") : "";

  const bleedCheckboxHtml = _bleedItem ? [
    '<label style="' + LABEL_STYLE + ' flex-direction:row; align-items:center; gap:8px; margin-top:8px;">',
    '  <input type="checkbox" name="suppress_bleed" style="width:16px; height:16px; cursor:pointer; margin:0;" />',
    '  <span>' + game.i18n.localize("SOTC.DamageWizardSuppressBleed") + '',
    '    <span style="font-weight:400; color:#888; font-size:10px;">',
    '      <img src="systems/sotc/assets/statuses/Bleed.png"',
    '           style="width:12px;height:12px;border:none;object-fit:contain;vertical-align:middle;margin-right:2px;">',
    '      ' + game.i18n.format("SOTC.DamageWizardSuppressBleedHint", {count: _bleedCount}),
    '    </span>',
    '  </span>',
    '</label>',
  ].join("") : "";

  const content = `
    <style>
      .sotc-wizard-wrap { font-family:"Signika",sans-serif; padding:4px 2px; }
      .sotc-wizard-header {
        display:flex; align-items:center; gap:10px;
        background:#1e1b2e; border:1px solid #4a3f6b;
        border-radius:8px; padding:10px 14px; margin-bottom:10px;
      }
      .sotc-wizard-badge {
        background:${badgeColor}; color:#fff; border-radius:4px;
        padding:2px 8px; font-size:11px; font-weight:700;
        text-transform:uppercase; letter-spacing:0.08em; white-space:nowrap;
      }
      .sotc-wizard-name  { color:#e8d9a0; font-weight:700; font-size:14px; flex:1; }
      .sotc-wizard-total { color:#fff; font-size:22px; font-weight:900; min-width:32px; text-align:right; }
      .sotc-section { background:#12111a; border:1px solid #3a3050; border-radius:6px; padding:10px 12px; }
      .sotc-die-btn:hover { opacity:0.85; }
      .sotc-wizard-hint  { color:#888; font-size:11px; margin-top:3px; display:block; }
    </style>
    <div class="sotc-wizard-wrap">
      <div class="sotc-wizard-header">
        <span class="sotc-wizard-badge">${payload.dieType}</span>
        <span class="sotc-wizard-name">${payload.itemName}</span>
        <span class="sotc-wizard-total">${payload.total}</span>
      </div>
      <div class="sotc-section">
        <label style="${LABEL_STYLE}">${game.i18n.localize("SOTC.DamageWizardCheckMod")}
          <input type="number" name="mod" value="0" style="${INPUT_STYLE}" />
        </label>
        <label style="${LABEL_STYLE} margin-bottom:6px;">${game.i18n.localize("SOTC.DamageWizardOpposingType")}</label>
        <input type="hidden" name="defender_die_type" value="none" />
        <div style="display:flex; gap:5px; margin-top:2px;">
          ${btnHTML}
        </div>
        <label style="${LABEL_STYLE}">${game.i18n.localize("SOTC.DamageWizardOpposingRoll")}
          <input type="number" name="defender_die" value="0" min="0" style="${INPUT_STYLE}" />
          <span class="sotc-wizard-hint">${game.i18n.localize("SOTC.DamageWizardUnopposedHint")}</span>
        </label>
        ${critCheckboxHtml}
        ${bleedCheckboxHtml}
      </div>
    </div>
  `;

  new Dialog({
    title: game.i18n.format("SOTC.DamageWizardTitle", {item: payload.itemName}),
    content,
    buttons: {
      resolve: {
        icon: '<i class="fas fa-bolt"></i>',
        label: game.i18n.localize("SOTC.ButtonResolve"),
        callback: html => resolveDamage(payload, html, token)
      },
      cancel: {
        icon: '<i class="fas fa-times"></i>',
        label: game.i18n.localize("SOTC.ButtonCancel")
      }
    },
    default: "resolve"
  }, { classes: ["sotc_damage_wizard"], width: 390 }).render({ force: true });
}

/**
 * Core resolution. Clash result is auto-detected.
 * targetActor   = selected token (receives win/unopposed damage)
 * attackerActor = from payload.actorId (receives clash-lose damage)
 * Both are updated via game.sotc.updateActor to support non-owned targets.
 */
async function resolveDamage(payload, html, targetToken) {
  // Re-check permission at resolve time in case setting changed mid-session
  if (!game.user.isGM && !game.settings.get("sotc", "playerDamageWizard")) {
    return ui.notifications.warn(game.i18n.localize("SOTC.NotifyDamageWizardGMOnly"));
  }

  const targetActor  = targetToken.actor;
  const mod          = Number(html.find('[name="mod"]').val()                || 0);
  const defenderType =        html.find('[name="defender_die_type"]').val()  ?? "none";
  const defenderRoll = Number(html.find('[name="defender_die"]').val()       || 0);
  const isCrit        =        html.find('[name="is_crit"]').prop("checked")       ?? false;
  const suppressBleed =        html.find('[name="suppress_bleed"]').prop("checked") ?? false;

  const attackPower = payload.total + mod;

  // ── Auto-detect clash result ───────────────────────────────────────────────
  const clashResult = defenderRoll === 0         ? "unopposed"
                    : attackPower > defenderRoll  ? "win"
                    : attackPower === defenderRoll ? "tie"
                    : "lose";

  const dieBase        = normaliseType(payload.dieType);
  const isOffensive    = isOffensiveType(dieBase);
  const isBlock        = dieBase === "block";
  const isEvade        = dieBase === "evade";
  const defIsOffensive = isOffensiveType(defenderType);
  const defIsBlock     = defenderType === "block" || defenderType === "counter-block";
  const defIsEvade     = defenderType === "evade" || defenderType === "counter-evade";

  const attackerActor = resolveAttackerActor(payload);

  let resultLabel = "";
  // Stats for the TARGET (token being hit on a win)
  let tDmg = 0, tStagger = 0, tStaggerGain = 0;
  // Stats for the ATTACKER (the one who lost the clash)
  let aDmg = 0, aStagger = 0, aStaggerGain = 0;

  // ══════════════════════════════════════════════════════════════════════════
  //  OFFENSIVE
  // ══════════════════════════════════════════════════════════════════════════
  if (isOffensive) {
    switch (clashResult) {

      case "win":
      case "unopposed": {
        [tDmg, tStagger] = applyAffinities(targetActor, dieBase, attackPower, attackPower);
        if (clashResult === "win" && defIsBlock) {
          tDmg     = Math.max(0, tDmg     - defenderRoll);
          tStagger = Math.max(0, tStagger - defenderRoll);
        }
        if (clashResult === "win" && defIsEvade) {
          tStagger = Math.max(0, tStagger - defenderRoll);
        }
        resultLabel = clashResult === "win"
          ? game.i18n.format("SOTC.DamageClashWinOffensive", {dmg: tDmg, stagger: tStagger, target: targetActor.name})
          : game.i18n.format("SOTC.DamageUnopposedOffensive", {dmg: tDmg, stagger: tStagger, target: targetActor.name});
        break;
      }

      case "tie": { resultLabel = game.i18n.localize("SOTC.DamageClashTie"); break; }

      case "lose": {
        if (defIsBlock) {
          // Block [Clash Win]: STAGGER ONLY = block−offensive, NO HP
          aStagger = Math.max(0, defenderRoll - attackPower);
          resultLabel = game.i18n.format("SOTC.DamageClashLoseBlock", {defender: targetActor.name, stagger: aStagger, attacker: attackerActor?.name ?? "attacker"});
        } else if (defIsEvade) {
          // Evade [Win vs Offensive]: recycled, no stats
          resultLabel = game.i18n.format("SOTC.DamageClashLoseEvade", {defender: targetActor.name});
        } else if (defIsOffensive && attackerActor) {
          // Offensive vs offensive — apply affinities to attacker
          const defBase = normaliseType(defenderType);
          [aDmg, aStagger] = applyAffinities(attackerActor, defBase, defenderRoll, defenderRoll);
          resultLabel = game.i18n.format("SOTC.DamageClashLoseOffensive", {attacker: attackerActor.name, dmg: aDmg, stagger: aStagger});
        } else {
          resultLabel = game.i18n.localize("SOTC.DamageClashLose");
        }
        break;
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  BLOCK
  // ══════════════════════════════════════════════════════════════════════════
  else if (isBlock) {
    switch (clashResult) {

      case "win": {
        if (defIsOffensive) {
          // Block wins vs offensive: net damage+stagger
          const net = Math.max(0, attackPower - defenderRoll);
          tDmg     = net;
          tStagger = net;
          resultLabel = game.i18n.format("SOTC.DamageBlockWinOffensive", {dmg: tDmg, stagger: tStagger, target: targetActor.name});
        } else {
          // Block wins vs block/evade/none: stagger only
          tStagger = Math.max(0, attackPower - defenderRoll);
          resultLabel = game.i18n.format("SOTC.DamageBlockWin", {stagger: tStagger, target: targetActor.name});
        }
        break;
      }

      case "tie": { resultLabel = game.i18n.localize("SOTC.DamageBlockTie"); break; }

      case "lose": {
        if (defIsOffensive && attackerActor) {
          const defBase  = normaliseType(defenderType);
          const netPower = Math.max(0, defenderRoll - attackPower);
          [aDmg, aStagger] = applyAffinities(attackerActor, defBase, netPower, netPower);
          resultLabel = game.i18n.format("SOTC.DamageBlockLoseOffensive", {blocked: attackPower, attacker: attackerActor.name, dmg: aDmg, stagger: aStagger});
        } else if (defIsEvade) {
          // Evade [Win vs Defensive]: target regains stagger = evade−block
          tStaggerGain = Math.max(0, defenderRoll - attackPower);
          resultLabel = game.i18n.format("SOTC.DamageBlockLoseEvade", {defender: targetActor.name, stagger: tStaggerGain});
        } else {
          resultLabel = game.i18n.localize("SOTC.DamageBlockLose");
        }
        break;
      }

      case "unopposed": {
        await targetToken.actor.setFlag("sotc", "savedBlock", { power: attackPower, source: payload.itemName });
        resultLabel = game.i18n.format("SOTC.DamageBlockUnopposed", {power: attackPower});
        break;
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  EVADE
  // ══════════════════════════════════════════════════════════════════════════
  else if (isEvade) {
    switch (clashResult) {

      case "win": {
        if (defIsOffensive) {
          resultLabel = game.i18n.localize("SOTC.DamageEvadeWinOffensive");
        } else {
          // The evader is attackerActor (they rolled the evade die)
          aStaggerGain = Math.max(0, attackPower - defenderRoll);
          resultLabel  = game.i18n.format("SOTC.DamageEvadeWinDefensive", {evader: attackerActor?.name ?? "Evader", stagger: aStaggerGain});
        }
        break;
      }

      case "tie": { resultLabel = game.i18n.localize("SOTC.DamageEvadeTie"); break; }

      case "lose": {
        if (defIsOffensive && attackerActor) {
          const defBase    = normaliseType(defenderType);
          const netStagger = Math.max(0, defenderRoll - attackPower);
          const [rawDmg]       = applyAffinities(attackerActor, defBase, defenderRoll, 0);
          const [, affStagger] = applyAffinities(attackerActor, defBase, 0, netStagger);
          aDmg     = rawDmg;
          aStagger = affStagger;
          resultLabel = game.i18n.format("SOTC.DamageEvadeLoseOffensive", {absorbed: attackPower, attacker: attackerActor.name, dmg: aDmg, stagger: aStagger});
        } else if (defIsBlock) {
          // Evade loses vs Block: attacker (evader) takes stagger = block − evade
          aStagger = Math.max(0, defenderRoll - attackPower);
          resultLabel = game.i18n.format("SOTC.DamageEvadeLoseBlock", {evader: attackerActor?.name ?? "Evader", stagger: aStagger});
        } else if (defIsEvade) {
          tStaggerGain = Math.max(0, defenderRoll - attackPower);
          resultLabel = game.i18n.format("SOTC.DamageEvadeLoseEvade", {defender: targetActor.name, stagger: tStaggerGain});
        } else {
          resultLabel = game.i18n.localize("SOTC.DamageEvadeLose");
        }
        break;
      }

      case "unopposed": {
        await targetToken.actor.setFlag("sotc", "savedEvade", { power: attackPower, source: payload.itemName });
        resultLabel = game.i18n.format("SOTC.DamageEvadeUnopposed", {power: attackPower});
        break;
      }
    }
  }

  // ── Snapshot pre-apply state for undo ────────────────────────────────────
  // Snapshot uses targetActor (already fresh from targetToken.actor above) and
  // re-fetches the attacker via canvas token for the same guarantee.
  const attackerToken = attackerActor
    ? canvas.tokens?.placeables?.find(t => t.actor?.id === attackerActor.id) ?? null
    : null;
  const freshAttacker = attackerToken ? attackerToken.actor : attackerActor;

  const snapshot = {
    target: {
      actorId:  targetActor.id,
      tokenId:  targetToken?.id ?? null,
      hp:       targetActor.system.health.value  ?? 0,
      stagger:  targetActor.system.stagger.value ?? 0,
    },
    attacker: freshAttacker ? {
      actorId:  freshAttacker.id,
      tokenId:  attackerToken?.id ?? null,
      hp:       freshAttacker.system.health.value  ?? 0,
      stagger:  freshAttacker.system.stagger.value ?? 0,
    } : null,
  };

  // ── Apply stats ───────────────────────────────────────────────────────────
  await applyStats(targetActor,   { dmg: tDmg, stagger: tStagger, staggerGain: tStaggerGain });
  if (attackerActor && (aDmg > 0 || aStagger > 0 || aStaggerGain > 0)) {
    await applyStats(attackerActor, { dmg: aDmg, stagger: aStagger, staggerGain: aStaggerGain });
  }

  // ── Bleed — fires when attacker uses an offensive die on win or unopposed ─
  // Rule: take HP = Count, then reduce by 1. Can be suppressed per-attack.
  const bleedStatLines = [];
  if (isOffensive && !suppressBleed && (clashResult === "win" || clashResult === "unopposed") && attackerActor) {
    const bleedStatus = attackerActor.items.find(i =>
      i.type === "status" && i.name.toLowerCase() === "bleed" && Number(i.system?.count ?? 0) > 0
    );
    if (bleedStatus) {
      const bleedDmg = Number(bleedStatus.system.count);
      await applyStats(attackerActor, { dmg: bleedDmg });
      await bleedStatus.update({ "system.count": Math.max(0, bleedDmg - 1) });
      bleedStatLines.push(
        '<span style="color:#c03030;display:flex;align-items:center;gap:4px;">' +
        '<img src="systems/sotc/assets/statuses/Bleed.png" style="width:16px;height:16px;border:none;object-fit:contain;"> ' +
        game.i18n.format("SOTC.DamageStatBleed", {dmg: bleedDmg, actor: attackerActor.name, from: bleedDmg, to: bleedDmg - 1}) +
        '</span>'
      );
    }
  }

  // ── Thorns — fires when the target takes HP damage from an offensive die ──
  // Rule: attacker loses HP = Thorns count. If Crit, damage is doubled.
  // Thorns are cleared at scene end (handled by scene_end_effect.operator = "clear").
  const thornsStatLines = [];
  const shouldApplyThorns = tDmg > 0 && attackerActor && isOffensive;
  if (shouldApplyThorns) {
    const thornsStatuses = targetActor.items.filter(i =>
      i.type === "status" &&
      i.system?.condition === "special" &&
      i.system?.special_trigger === "on_receive_damage" &&
      Number(i.system?.count ?? 0) > 0
    );
    for (const thorns of thornsStatuses) {
      let thornsDmg = Number(thorns.system.count);
      if (isCrit) thornsDmg *= 2;
      await applyStats(attackerActor, { dmg: thornsDmg });
      thornsStatLines.push(
        `<span style="color:#e07030;display:flex;align-items:center;gap:4px;"><img src="${thorns.img || 'systems/sotc/assets/statuses/Thorns.png'}" style="width:16px;height:16px;border:none;object-fit:contain;"> ${game.i18n.format("SOTC.DamageStatThorns", {name: thorns.name, dmg: isCrit ? game.i18n.format("SOTC.DamageStatThornsCrit", {dmg: thornsDmg}) : thornsDmg, actor: attackerActor.name})}</span>`
      );
    }
  }

  // ── Emotion Points — every qualifying actor in the clash gains 1 EP ───────
  // Unopposed is not a clash, so no EP awarded.
  const epStatLines = [];
  if (clashResult !== "unopposed") {
    const enemyEpEnabled = game.settings.get("sotc", "enemyEmotionPoints");
    const epActors = [targetActor, attackerActor].filter(a => {
      if (!a) return false;
      if (a.system?.initiative_type === "player") return true;
      return enemyEpEnabled;
    });
    for (const a of epActors) {
      const currentEp = Number(a.system.emotion ?? 0);
      const maxEp     = Number(a.system.emotion_max ?? a.system.emotionMax ?? 99);
      const newEp     = Math.min(maxEp, currentEp + 1);
      if (newEp > currentEp) {
        await game.sotc.updateActor(a, { emotion: newEp - currentEp });
        epStatLines.push(`<span style="color:#c9a227;">${game.i18n.format("SOTC.DamageStatEP", {actor: a.name})}</span>`);
      }
    }
  }

  // ── Chat result message ───────────────────────────────────────────────────
  const clashLabel = {
    win: game.i18n.localize("SOTC.ClashWin"),
    tie: game.i18n.localize("SOTC.ClashTie"),
    lose: game.i18n.localize("SOTC.ClashLose"),
    unopposed: game.i18n.localize("SOTC.ClashUnopposed")
  }[clashResult];
  const clashColor = { win: "#4caf7d", tie: "#c9a227", lose: "#e05050", unopposed: "#aaa" }[clashResult];

  const statLines = [];
  if (tDmg        > 0) statLines.push(`<span style="color:#e05050;">${game.i18n.format("SOTC.DamageStatHP", {value: tDmg, actor: targetActor.name})}</span>`);
  if (tStagger    > 0) statLines.push(`<span style="color:#e0943a;">${game.i18n.format("SOTC.DamageStatStagger", {value: tStagger, actor: targetActor.name})}</span>`);
  if (tStaggerGain> 0) statLines.push(`<span style="color:#4caf7d;">${game.i18n.format("SOTC.DamageStatStaggerRegain", {value: tStaggerGain, actor: targetActor.name})}</span>`);
  if (aDmg        > 0) statLines.push(`<span style="color:#e05050;">${game.i18n.format("SOTC.DamageStatHP", {value: aDmg, actor: attackerActor?.name})}</span>`);
  if (aStagger    > 0) statLines.push(`<span style="color:#e0943a;">${game.i18n.format("SOTC.DamageStatStagger", {value: aStagger, actor: attackerActor?.name})}</span>`);
  if (aStaggerGain> 0) statLines.push(`<span style="color:#4caf7d;">${game.i18n.format("SOTC.DamageStatStaggerRegain", {value: aStaggerGain, actor: attackerActor?.name})}</span>`);
  statLines.push(...epStatLines);
  statLines.push(...bleedStatLines);
  statLines.push(...thornsStatLines);

  const snapshotJson = JSON.stringify(snapshot).replace(/'/g, "&#39;");
  const hasEffect = tDmg || tStagger || tStaggerGain || aDmg || aStagger || aStaggerGain || thornsStatLines.length;

  // ── Build a self-contained row for this die resolution ──────────────────
  // Build compact stat summary for the always-visible summary bar
  const previewStats = [];
  if (tDmg > 0)         previewStats.push(`<span style="color:#e05050;">${tDmg} HP</span>`);
  if (tStagger > 0)     previewStats.push(`<span style="color:#e0943a;">${game.i18n.format("SOTC.DamageStatStaggerShort", {value: tStagger})}</span>`);
  if (aDmg > 0)         previewStats.push(`<span style="color:#e05050;">${game.i18n.format("SOTC.DamageStatHP", {value: aDmg, actor: attackerActor?.name})}</span>`);
  if (aStagger > 0)     previewStats.push(`<span style="color:#e0943a;">${game.i18n.format("SOTC.DamageStatStagger", {value: aStagger, actor: attackerActor?.name})}</span>`);
  if (tStaggerGain > 0) previewStats.push(`<span style="color:#4caf7d;">${game.i18n.format("SOTC.DamageStatStaggerBack", {value: tStaggerGain})}</span>`);
  if (aStaggerGain > 0) previewStats.push(`<span style="color:#4caf7d;">${game.i18n.format("SOTC.DamageStatStaggerBack", {value: aStaggerGain})}</span>`);

  const previewPill = `
    <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
      <span style="background:#1a1a2a; color:${clashColor}; border:1px solid #3a3050; border-radius:4px; padding:1px 7px; font-size:11px; font-weight:700;">${payload.dieType} → ${attackPower} · ${clashLabel}</span>
      ${previewStats.length ? `<span style="font-size:11px; color:#aaa;">${previewStats.join('<span style="color:#555;"> · </span>')}</span>` : ""}
    </div>`;

  const dieRow = `
    <div class="sotc-clash-row" style="border-top:1px solid #2a2540; padding:7px 0 4px; margin-top:4px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3px;">
        <span style="background:#2a2040; color:#c9a227; border-radius:4px; padding:1px 7px; font-size:11px; font-weight:700;">${payload.dieType} → ${attackPower}</span>
        <span style="font-size:11px; font-weight:700; color:${clashColor};">${clashLabel}</span>
      </div>
      <div style="font-size:12px; color:#ccc; margin-bottom:3px;">${resultLabel}</div>
      ${statLines.length ? `<div style="display:flex; flex-direction:column; gap:1px; font-size:12px;">${statLines.join("")}</div>` : ""}
      ${hasEffect ? `
        <a class="sotc-undo-damage" data-snapshot='${snapshotJson}'
           style="display:inline-flex; align-items:center; gap:5px; background:#2a1a1a; border:1px solid #6b2a2a; border-radius:4px; padding:2px 8px; font-size:11px; font-weight:700; color:#e07070; text-transform:uppercase; letter-spacing:0.06em; cursor:pointer; text-decoration:none; margin-top:4px;">
          <i class="fas fa-rotate-left"></i> ${game.i18n.localize("SOTC.ButtonUndo")}
        </a>` : ""}
    </div>`;

  // ── Merge into existing clash group card or create a new one ────────────
  const sourceId = payload.sourceMessageId;
  const existing = sourceId
    ? game.messages.find(m => m.getFlag("sotc", "clashGroup") === sourceId)
    : null;

  if (existing) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(existing.content, "text/html");
    const container = doc.querySelector(".sotc-clash-rows");
    const summary = doc.querySelector(".sotc-clash-summary");
    if (container) {
      container.insertAdjacentHTML("beforeend", dieRow);
      // Update summary bar to show latest clash result
      if (summary) summary.innerHTML = previewPill;
      // Collapse after appending so chat stays compact
      container.dataset.collapsed = "true";
      container.style.display = "none";
      await existing.update({ content: doc.body.innerHTML });
    }
  } else {
    // First resolution — create the grouped card (starts expanded)
    const headerContent = `
      <div style="background:#12111a; border:1px solid #3a3050; border-radius:6px; padding:10px 12px; font-family:'Signika',sans-serif; line-height:1.6;">
        <div class="sotc-clash-toggle" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; cursor:pointer; user-select:none;">
          <div style="display:flex; align-items:center; gap:6px;">
            <i class="fas fa-chevron-down sotc-clash-chevron" style="font-size:10px; color:#888; transition:transform 0.15s;"></i>
            <strong style="color:#e8d9a0; font-size:14px;">${payload.itemName}</strong>
          </div>
          <span style="color:#aaa; font-size:11px;">${game.i18n.format("SOTC.ClashVs", {name: targetActor.name})}</span>
        </div>
        <div class="sotc-clash-summary" style="margin-bottom:4px;">${previewPill}</div>
        <div class="sotc-clash-rows" data-collapsed="false">${dieRow}</div>
      </div>`;
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker(),
      content: headerContent,
      flags: { sotc: { clashGroup: sourceId ?? foundry.utils.randomID() } }
    });
  }
}