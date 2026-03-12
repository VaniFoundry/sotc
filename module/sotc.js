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
      
      function computeSpeedModFromStatuses(actor) {
        if (!actor) return 0;
        let speed_mod = 0;
        const statuses = actor.items.filter(i => i.type === "status" && (i.system?.condition === "passive") && (Number(i.system?.count) > 0));
        for (const status of statuses) {
          const { effect, target, potency_flat = 0, potency = 0, count = 0 } = status.system;
          if (!target) continue;
          const sign = (effect === "Increase") ? 1 : -1;
          const bonus = (Number(potency_flat || 0) + Number(potency || 0) * Number(count || 0)) * sign;
          if (target === "speed") speed_mod += bonus;
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

        const status_speed_mod = computeSpeedModFromStatuses(actor);
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

        // Post chat message — sound is suppressed here; rollAll plays it once manually
        await roll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor: c.actor }),
          flavor: `${c.name} rolls initiative (${roll.total - init_mod} → ${final_init})`,
          sound: CONFIG.sounds.dice ?? null,
        }, messageOptions);
      }

      // Update initiatives
      await this.updateEmbeddedDocuments("Combatant", updates);
      if (updateTurn) this.update({ turn: this.turns.findIndex(t => t.initiative !== null) });
      return this;
    }

    async rollAll(options = {}) {
      // Roll all combatants ourselves in one batch — bypassing super.rollAll()
      // so we can guarantee the sound plays exactly once at the end.
      const ids = this.combatants
        .filter(c => c.initiative === null)
        .map(c => c.id);
      if (!ids.length) return this;

      // Silence sound for every individual roll
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
  // PLEASE come back and localize this later. We should ideally make this work for like, Russian, Korean, Chinese, and Japanese if we're serious about it.
  CONFIG.Actor.types = ["character"]; // No NPC Yet!!!!!!
  CONFIG.Item.types = ["skill", "ego", "status", "passive"];
  CONFIG.Actor.typeLabels = {
    character: "Character",
  //  npc: "NPC"  <- Still Not Yet!!!!!!!!!!
  };
  CONFIG.Item.typeLabels = {
    skill: "Skill",
    ego: "EGO",
    status: "Status",
    passive: "Passive"
  };

  // Register sheet application classes
  Actors.unregisterSheet("core", ActorSheet);
  Actors.registerSheet("sotc", SotCActorSheet, {types: ["character"], makeDefault: true});
  Items.unregisterSheet("core", ItemSheet);
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

  html.find(".combatant").each((_, el) => {
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
    usedButton.dataset.tooltip = "Toggle Speed Dice as Used/Unused";
    usedButton.setAttribute("aria-label", "Toggle Speed Dice as Used/Unused");
    usedButton.setAttribute("role", "button");

    // Icon reflects use state yippeeeeee
    const icon = document.createElement("img");
    icon.src = isUsed ? "systems/sotc/assets/icons/used.png" : "systems/sotc/assets/icons/unused.png";
    icon.alt = "Used Speed Die";
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

  const temp_num_dice = actor.system.speed_dice.num_dice ?? 1;
  if (temp_num_dice <= 1) return;

  // You had to start with 1 combatant already to get more, obv
  setTimeout(async () => {
    for (let i = 1; i < temp_num_dice; i++) {
      await combatant.parent.createEmbeddedDocuments("Combatant", [{
        actorId: actor.id,
        tokenId: combatant.tokenId,
        hidden: false,
        initiative: null,
        name: `${combatant.name} #${i + 1}`,
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
      console.log(`Overriding initiative roll for ${combatant.name} with formula: ${actorFormula}`);
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
  console.log("Starting new round: resetting all speed dice initiative, restoring light, removing stagger_likes (where appropriate), handling end of scene effects");

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
    let delta_hp = 0;
    let delta_stagger = 0;
    for (const status of statuses) {
      if ((status.system.condition === "active") && (status.system.scene_end_effect.activate_var === "activate")) {
        const effect_type = status.system.effect;
        const flat_change = Number(status.system.potency_flat ?? 0)
        const potency = Number(status.system.potency ?? 1);
        const count = Number(status.system.count ?? 0);
        let delta = count * potency + flat_change;
        const sign = effect_type === "Decrease" ? -1 : 1;
        if (status.system.target === "hp" || status.system.target === "hp_stagger") {
          delta_hp += delta * sign
        }
        if (status.system.target === "stagger" || status.system.target === "hp_stagger") {
          delta_stagger += delta * sign
        }
      }
      if (status.system.scene_end_effect.operator === "clear") {
        status_updates.push({
          _id: status.id,
          "system.count": 0
        })
      } else if (status.system.scene_end_effect.operator !== "maintain") {
        const new_count = applyOperator(status.system.count, status.system.scene_end_effect.operator, status.system.scene_end_effect.variable);
        status_updates.push({
          _id: status.id,
          "system.count": Math.max(new_count, 0)
        })
      }
    }
    if (delta_hp) {
      actor_updates["system.health.value"] = (actor.system.health.value ?? 0) + delta_hp;
    }
    if (delta_stagger) {
      actor_updates["system.stagger.value"] = (actor.system.stagger.value ?? 0) + delta_stagger;
    }

    if (status_updates.length) {
      await actor.updateEmbeddedDocuments("Item", status_updates);
    }

    const light = actor.system.light;
    if (!modifiers.null_light_regen) {
      const current = Number(light.value) || 0;
      const regen = Number(light.light_regen) || 0;
      const max = Number(light.max) || current;

      if (regen !== 0 && current < max) {
        const new_val = Math.min(current + regen, max);
        actor_updates["system.light.value"] = new_val;
      }
    }


    if (Object.keys(actor_updates).length) {
      await actor.update(actor_updates);
    }
    if (Object.keys(actor_stag_updates).length) {
      await actor.update(actor_stag_updates);
    }
  }
  
  if (combatant_updates.length) {
    await combat.updateEmbeddedDocuments("Combatant", combatant_updates);
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
  return actor.effects.find(e => e.statuses?.has(statusId));
}

// Helper that correctly gives us our ActiveEffects or obliterates them from existence
async function syncStatusItemEffect(item) {
  if (item.type !== "status") return;
  const actor = item.actor;
  if (!actor) return;

  // Needs testing! If I haven't deleted this comment then I am a chud loser cringelord!!!
  if (!actor.isOwner || !(game.user === game.users.activeGM)) return;

  const count = Number(item.system?.count ?? 0);
  const existing = getActorStatusEffect(actor, item.id);

  // Add when need to
  if (count > 0 && !existing) {
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name: item.name,
      icon: item.img,
      statuses: [item.id],
      origin: item.uuid,
      transfer: false,
      flags: {
        sotc: {
          statusItemId: item.id
        }
      }
    }]);
    return;
  }

  // Remove when need to
  if (count <= 0 && existing) {
    await existing.delete();
  }
}

Hooks.once("ready", () => {

  // ── Custom dice sound ───────────────────────────────────────────────────
  CONFIG.sounds.dice = "systems/sotc/assets/audio/speed_dice.mp3";
  console.log("sotc | Custom dice sound registered ✓");

  // ── Socket: allow players to update actors they do not own (e.g. applying
  // ── damage to an enemy token). The active GM executes the update.
  const SOCKET_NAME = "system.sotc";

  game.socket.on(SOCKET_NAME, async (data) => {
    if (!game.user.isGM || !game.users.activeGM?.isSelf) return;
    if (data.type === "actorUpdate") {
      const actor = game.actors.get(data.actorId);
      if (!actor) return;
      await actor.update(data.updates);
    }
  });

  /**
   * Update an actor. If the user owns it, update directly.
   * Otherwise proxy through the GM via socket.
   */
  game.sotc.updateActor = async function(actor, updates) {
    if (actor.isOwner) {
      await actor.update(updates);
    } else {
      game.socket.emit(SOCKET_NAME, { type: "actorUpdate", actorId: actor.id, updates });
    }
  };


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
        return src && src.includes(effect.icon.split("/").pop());
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

// Relevent only to our status effects, not any of the other items that may be created. Since our helper only does anything for statuses, we can call this senselessly
Hooks.on("createItem", async (item) => {
  await syncStatusItemEffect(item);
});

Hooks.on("updateItem", async (item, changes) => {
  if (item.type !== "status") return;

  // Redundant safety
  if (changes?.system?.count === undefined) return;

  await syncStatusItemEffect(item);
});

// If we delete something, we want to make sure it doesn't get permanently stuck rendering. That'd be real awkward
Hooks.on("deleteItem", async (item) => {
  if (item.type !== "status") return;

  const effect = getStatusEffectForItem(item);
  if (effect) await effect.delete();
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

  // Create them on the actor (skip if actor already has items with the same name)
  await actor.createEmbeddedDocuments("Item", items.filter(item =>
    !actor.items.some(ai => ai.name === item.name)
  ));
});

Hooks.on("renderChatMessage", (message, html) => {
  html.find(".reroll-die").on("click", async ev => {
    ev.preventDefault();
    const btn = ev.currentTarget;

    const item_name = btn.dataset.itemname || "Unknown Item";
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
            modules.map(m => `<div style="margin-left: 5px;">• ${m}</div>`).join("")
          }</em></div>`
        : "";

      const payload = {
        dieType: type,
        total: roll.total,
        itemName: item_name,
        isOffensive: ["slash","pierce","blunt","counter-slash","counter-pierce","counter-blunt"].includes(type),
        isDefensive: ["block","evade","counter-block","counter-evade"].includes(type),
        actorId: ChatMessage.getSpeaker()?.actor ?? null
      };

      const messageContent = `
        <div class="skill-die-roll">
          <h3>${item_name} - Reroll ${type}</h3>
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
                  title="Reroll die!" 
                  style="width: 16px; height: 16px; color: black; margin-top: 4px; margin-left: 8px;">
                  <i class="fas fa-rotate-left"></i>
                </a>
                <a class="resolve-die"
                  title="Apply Die!"
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
      ui.notifications.error("Could not reroll... :(");
    }
  });

  // Everything below this point should REALLY be in a separate .js document. I did this here because I could not be fucked to move it over
  // It is sunday, at 2:25 am and I feel like that one guy who did some songs for furi who names his tracks after the time when he finishes them
  // which is to say... fulfilled? I'm basically there and just reviewing code at this point...
  // But I kind of want to explode...
  html.find(".resolve-die").on("click", ev => {
    const payload = JSON.parse(ev.currentTarget.dataset.payload);
    openDamageWizard(payload); // token is resolved inside from game.user.targets
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
  const updates = {};

  if (dmg > 0) {
    updates["system.health.value"] = (actor.system.health.value ?? 0) - dmg;
  }
  if (stagger > 0) {
    const curr  = actor.system.stagger.value ?? 0;
    const maxSt = actor.system.stagger.max   ?? curr;
    updates["system.stagger.value"] = Math.max(0, Math.min(maxSt, curr - stagger));
  }
  if (staggerGain > 0) {
    const curr  = actor.system.stagger.value ?? 0;
    const maxSt = actor.system.stagger.max   ?? curr;
    updates["system.stagger.value"] = Math.min(maxSt, curr + staggerGain);
  }

  if (Object.keys(updates).length) {
    await game.sotc.updateActor(actor, updates);
  }
}

/**
 * Build and open the Damage Wizard dialog.
 * Opposing die type is chosen via one-click icon buttons (no dropdown).
 */
async function openDamageWizard(payload) {
  const targets = Array.from(game.user.targets);
  if (!targets.length) {
    return ui.notifications.warn("Select a target first!");
  }

  const token   = targets[0];
  const actor   = token.actor;
  const dieBase = normaliseType(payload.dieType);

  const badgeColor = isOffensiveType(dieBase) ? "#7a1a1a"
                   : dieBase === "block"       ? "#1a3f7a"
                   :                             "#1a5e35";

  const dieButtons = [
    { value: "none",   label: "None",   icon: null,                                          color: "#444"    },
    { value: "slash",  label: "Slash",  icon: "systems/sotc/assets/dice types/slash.png",   color: "#8b1a1a" },
    { value: "pierce", label: "Pierce", icon: "systems/sotc/assets/dice types/pierce.png",  color: "#7a3a00" },
    { value: "blunt",  label: "Blunt",  icon: "systems/sotc/assets/dice types/blunt.png",   color: "#5a4a00" },
    { value: "block",  label: "Block",  icon: "systems/sotc/assets/dice types/block.png",   color: "#1a3f7a" },
    { value: "evade",  label: "Evade",  icon: "systems/sotc/assets/dice types/evade.png",   color: "#1a5e35" },
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
        <label style="${LABEL_STYLE}">Check Modifier (Attacker's Roll)
          <input type="number" name="mod" value="0" style="${INPUT_STYLE}" />
        </label>
        <label style="${LABEL_STYLE} margin-bottom:6px;">Opposing Die Type</label>
        <input type="hidden" name="defender_die_type" value="none" />
        <div style="display:flex; gap:5px; margin-top:2px;">
          ${btnHTML}
        </div>
        <label style="${LABEL_STYLE}">Opposing Die Roll
          <input type="number" name="defender_die" value="0" min="0" style="${INPUT_STYLE}" />
          <span class="sotc-wizard-hint">Leave at 0 for Unopposed</span>
        </label>
      </div>
    </div>
  `;

  new Dialog({
    title: `Damage Wizard — ${payload.itemName}`,
    content,
    buttons: {
      resolve: {
        icon: '<i class="fas fa-bolt"></i>',
        label: "Resolve",
        callback: html => resolveDamage(payload, html, actor, token)
      },
      cancel: {
        icon: '<i class="fas fa-times"></i>',
        label: "Cancel"
      }
    },
    default: "resolve"
  }, { classes: ["sotc_damage_wizard"], width: 390 }).render(true);
}

/**
 * Core resolution. Clash result is auto-detected.
 * targetActor   = selected token (receives win/unopposed damage)
 * attackerActor = from payload.actorId (receives clash-lose damage)
 * Both are updated via game.sotc.updateActor to support non-owned targets.
 */
async function resolveDamage(payload, html, targetActor, targetToken) {
  const mod          = Number(html.find('[name="mod"]').val()                || 0);
  const defenderType =        html.find('[name="defender_die_type"]').val()  ?? "none";
  const defenderRoll = Number(html.find('[name="defender_die"]').val()       || 0);

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
  const defIsBlock     = defenderType === "block";
  const defIsEvade     = defenderType === "evade";

  const attackerActor = resolveAttackerActor(payload);

  let resultLabel = "";
  // Stats for the TARGET (token being hit on a win)
  let tDmg = 0, tStagger = 0, tStaggerGain = 0;
  // Stats for the ATTACKER (the one who lost the clash)
  let aDmg = 0, aStagger = 0;

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
          ? `Clash Win — dealt ${tDmg} damage and ${tStagger} stagger to ${targetActor.name}`
          : `Unopposed — dealt ${tDmg} damage and ${tStagger} stagger to ${targetActor.name}`;
        break;
      }

      case "tie": { resultLabel = "Clash Tie — no effect."; break; }

      // The attacker lost — opposing offensive die hits them back
      case "lose": {
        if (defIsOffensive && attackerActor) {
          aDmg     = defenderRoll;
          aStagger = defenderRoll;
          resultLabel = `Clash Lose vs Offensive — ${attackerActor.name} takes ${aDmg} damage and ${aStagger} stagger`;
        } else {
          resultLabel = "Clash Lose — no effect.";
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
        tStagger = Math.max(0, attackPower - defenderRoll);
        resultLabel = `Block Clash Win — dealt ${tStagger} stagger to ${targetActor.name}`;
        break;
      }

      case "tie": { resultLabel = "Block Clash Tie — no effect."; break; }

      // Block absorbed attackPower; remaining hits the block user
      case "lose": {
        if (defIsOffensive && attackerActor) {
          aDmg     = Math.max(0, defenderRoll - attackPower);
          aStagger = Math.max(0, defenderRoll - attackPower);
          resultLabel = `Block Clash Lose — blocked ${attackPower}, ${attackerActor.name} takes net ${aDmg} damage and ${aStagger} stagger`;
        } else {
          resultLabel = "Block Clash Lose — no special effect.";
        }
        break;
      }

      case "unopposed": {
        await game.sotc.updateActor(targetToken.actor, {});
        await targetToken.actor.setFlag("sotc", "savedBlock", { power: attackPower, source: payload.itemName });
        resultLabel = `Block Unopposed — die saved for later this scene (power: ${attackPower})`;
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
          resultLabel = `Evade Clash Win vs Offensive — die recycled! No other Clash Win effects trigger.`;
        } else {
          tStaggerGain = Math.max(0, attackPower - defenderRoll);
          resultLabel  = `Evade Clash Win vs Defensive — ${targetActor.name} regains ${tStaggerGain} stagger`;
        }
        break;
      }

      case "tie": { resultLabel = "Evade Clash Tie — no effect."; break; }

      // Evade softens the stagger; remainder still lands on the evade user
      case "lose": {
        if (defIsOffensive && attackerActor) {
          aStagger    = Math.max(0, defenderRoll - attackPower);
          resultLabel = `Evade Clash Lose vs Offensive — evade absorbed ${attackPower} stagger, ${attackerActor.name} takes net ${aStagger} stagger`;
        } else {
          resultLabel = "Evade Clash Lose — no special effect.";
        }
        break;
      }

      case "unopposed": {
        await targetToken.actor.setFlag("sotc", "savedEvade", { power: attackPower, source: payload.itemName });
        resultLabel = `Evade Unopposed — die saved for later this scene (power: ${attackPower})`;
        break;
      }
    }
  }

  // ── Apply stats ───────────────────────────────────────────────────────────
  await applyStats(targetActor,   { dmg: tDmg, stagger: tStagger, staggerGain: tStaggerGain });
  if (attackerActor && (aDmg > 0 || aStagger > 0)) {
    await applyStats(attackerActor, { dmg: aDmg, stagger: aStagger });
  }

  // ── Chat result message ───────────────────────────────────────────────────
  const clashLabel = { win: "Clash Win", tie: "Clash Tie", lose: "Clash Lose", unopposed: "Unopposed" }[clashResult];

  const statLines = [];
  if (tDmg        > 0) statLines.push(`<span style="color:#e05050;">${tDmg} HP → ${targetActor.name}</span>`);
  if (tStagger    > 0) statLines.push(`<span style="color:#e0943a;">${tStagger} stagger → ${targetActor.name}</span>`);
  if (tStaggerGain> 0) statLines.push(`<span style="color:#4caf7d;">+${tStaggerGain} stagger regained by ${targetActor.name}</span>`);
  if (aDmg        > 0) statLines.push(`<span style="color:#e05050;">${aDmg} HP → ${attackerActor?.name}</span>`);
  if (aStagger    > 0) statLines.push(`<span style="color:#e0943a;">${aStagger} stagger → ${attackerActor?.name}</span>`);

  const msgContent = `
    <div style="background:#12111a; border:1px solid #3a3050; border-radius:6px; padding:10px 12px; font-family:'Signika',sans-serif; line-height:1.6;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
        <strong style="color:#e8d9a0; font-size:14px;">${payload.itemName}</strong>
        <span style="background:#2a2040; color:#c9a227; border-radius:4px; padding:1px 7px; font-size:11px; font-weight:700;">${payload.dieType} → ${attackPower}</span>
      </div>
      <div style="color:#aaa; font-size:12px; margin-bottom:6px;">
        Target: <strong style="color:#ddd;">${targetActor.name}</strong>
        &nbsp;·&nbsp;
        <strong style="color:#c9a227;">${clashLabel}</strong>
      </div>
      <div style="border-top:1px solid #3a3050; padding-top:6px; font-size:13px; color:#ccc;">
        ${resultLabel}
      </div>
      ${statLines.length ? `<div style="margin-top:6px; display:flex; flex-direction:column; gap:2px; font-size:13px;">${statLines.join("")}</div>` : ""}
    </div>
  `;

  await ChatMessage.create({ speaker: ChatMessage.getSpeaker(), content: msgContent });
}