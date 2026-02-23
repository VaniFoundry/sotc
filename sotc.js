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

        // Post chat message
        await roll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor: c.actor }),
          flavor: `${c.name} rolls initiative (${roll.total - init_mod} → ${final_init})`,
        }, messageOptions);
      }

      // Update initiatives
      await this.updateEmbeddedDocuments("Combatant", updates);
      if (updateTurn) this.update({ turn: this.turns.findIndex(t => t.initiative !== null) });
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
    const processed_key = c.token?.isLinked ? actor.id : c.tokenId;
    if (processed_actors.has(processed_key)) continue;
    processed_actors.add(processed_key);

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


// When combat ends entirely, run the same end-of-scene logic that combatRound runs.
// Without this, statuses with scene_end_effect operators never fire on the final round.
Hooks.on("deleteCombat", async (combat) => {
  console.log("Combat ended: running end scene effects, clearing stagger_likes, restoring light.");

  const processed_actors = new Set();

  for (let c of combat.combatants) {
    const actor_updates = {};
    const actor_stag_updates = {};
    const actor = c.actor;
    if (!actor?.system?.speed_dice) continue;

    // Clear any remaining stagger_like statuses
    const stag_status_updates = [];
    const stag_statuses = actor.items.filter(i =>
      i.type === "status" &&
      i.system.condition === "stagger_like" &&
      i.system.count > 0
    );
    for (const stag_status of stag_statuses) {
      if (stag_status.system.stagger_effects?.reset_stagger) {
        actor_stag_updates["system.stagger.value"] = actor.system.stagger.max;
      }
      stag_status_updates.push({ _id: stag_status.id, "system.count": 0 });
    }
    if (stag_status_updates.length) {
      await actor.updateEmbeddedDocuments("Item", stag_status_updates);
    }

    // Only process scene end effects once per actor (multiple speed dice combatants share an actor)
    const processed_key = c.token?.isLinked ? actor.id : c.tokenId;
    if (processed_actors.has(processed_key)) continue;
    processed_actors.add(processed_key);

    const modifiers = actor.system.modifiers ?? {};
    const status_updates = [];
    const statuses = actor.items.filter(i =>
      i.type === "status" &&
      i.system.condition !== "stagger_like" &&
      i.system.count > 0
    );

    let delta_hp = 0;
    let delta_stagger = 0;

    for (const status of statuses) {
      if (
        status.system.condition === "active" &&
        status.system.scene_end_effect?.activate_var === "activate"
      ) {
        const effect_type = status.system.effect;
        const flat_change = Number(status.system.potency_flat ?? 0);
        const potency = Number(status.system.potency ?? 1);
        const count = Number(status.system.count ?? 0);
        const delta = count * potency + flat_change;
        const sign = effect_type === "Decrease" ? -1 : 1;
        if (status.system.target === "hp" || status.system.target === "hp_stagger") {
          delta_hp += delta * sign;
        }
        if (status.system.target === "stagger" || status.system.target === "hp_stagger") {
          delta_stagger += delta * sign;
        }
      }
      const op = status.system.scene_end_effect?.operator;
      if (op === "clear") {
        status_updates.push({ _id: status.id, "system.count": 0 });
      } else if (op && op !== "maintain") {
        const new_count = applyOperator(
          status.system.count,
          op,
          status.system.scene_end_effect.variable
        );
        status_updates.push({ _id: status.id, "system.count": Math.max(new_count, 0) });
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

    // Restore light at combat end, same as round start
    const light = actor.system.light;
    if (!modifiers.null_light_regen) {
      const current = Number(light.value) || 0;
      const regen = Number(light.light_regen) || 0;
      const max = Number(light.max) || current;
      if (regen !== 0 && current < max) {
        actor_updates["system.light.value"] = Math.min(current + regen, max);
      }
    }

    if (Object.keys(actor_updates).length) await actor.update(actor_updates);
    if (Object.keys(actor_stag_updates).length) await actor.update(actor_stag_updates);
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
  const originalDrawEffects = Token.prototype.drawEffects;
  Token.prototype.drawEffects = async function (...args) {
    await originalDrawEffects.apply(this, args);

    // Delay for foundry to finish its work, as we aim to hook onto the status icon and place the count badge on top of it
    await new Promise(resolve => requestAnimationFrame(resolve));

    const actor = this.actor;
    if (!actor || !this.effects) return;

    // Here are the sprites that have been placed previously that we then go backwards from to add the badges to
    const sprites = this.effects.children.filter(c => c.isSprite);
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
      badge.position.set(
        bounds.width,
        bounds.height
      )

      sprite.addChild(badge);
    }
  };
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

  const actor = item.actor;
  if (!actor) return;

  const effect = getActorStatusEffect(actor, item.id);
  if (effect) await effect.delete();
});


// When a token is linked to an actor, ensure the actor has all default statuses.
// Without this, linking a token erases untracked embedded statuses since the actor becomes the source of truth.
Hooks.on("updateToken", async (tokenDocument, changes, options, userId) => {
  // Only care about actorLink being set to true
  if (!changes.actorLink) return;

  // Only run on the user who made the change to avoid duplicate writes
  if (userId !== game.user.id) return;

  const actor = tokenDocument.actor;
  if (!actor) return;

  const pack = game.packs.get("sotc.default-statuses");
  if (!pack) {
    console.error("SotC | Default statuses compendium not found.");
    return;
  }

  const statuses = await pack.getDocuments();
  const items = statuses.map(s => s.toObject());

  // Add any missing statuses — skip ones the actor already has by name
  const missing = items.filter(item => !actor.items.some(ai => ai.name === item.name));
  if (missing.length) {
    await actor.createEmbeddedDocuments("Item", missing);
    console.log(`SotC | Linked token: added ${missing.length} missing status(es) to ${actor.name}.`);
    ui.notifications.info(`${actor.name}: ${missing.length} missing status(es) restored after linking.`);
  }
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
        isDefensive: ["block","evade","counter-block","counter-evade"].includes(type)
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
    openDamageWizard(payload);
  });
});

async function openDamageWizard(payload) {
  const targets = Array.from(game.user.targets);
  if (!targets.length) {
    return ui.notifications.warn("Select a target!");
  }

  const token = targets[0];
  const actor = token.actor;

  const content = await renderTemplate("systems/sotc/templates/damage-wizard.html", {
    payload
  });

  new Dialog({
    title: `Damage Wizard`,
    content,
    buttons: {
      resolve: {
        label: "Resolve",
        callback: html => resolveDamage(payload, html, actor)
      },
      cancel: { label: "Cancel" }
    }
  }, {
    classes: ["sotc_damage_wizard"]
  }).render(true);
}

async function resolveDamage(payload, html, targetActor) {
  const mod = Number(html.find('[name="mod"]').val() || 0);
  const defenderType = html.find('[name="defender_die_type"]').val();
  const defenderRoll = Number(html.find('[name="defender_die"]').val() || 0);

  const attack = payload.total + mod;

  let damage = 0;
  let stagger = 0;

  if (payload.isDefensive && (defenderType === "evade" || defenderType === "counter-evade") && (defenderRoll > attack)) {
    const curr = targetActor.system.stagger.value;
    const final = Math.min(targetActor.system.stagger.max, curr + defenderRoll - attack);
    await targetActor.update({ "system.stagger.value": final });
    return;
  }

  // With evasion taken care of, we can just straight up leave if the attack roll is less than or equal to the defender's roll (clash won)
  if (defenderRoll >= attack) return;

  if (payload.isOffensive) {
    damage = attack;
    stagger = attack;
    if (payload.dieType === "slash" || payload.dieType === "counter-slash") {
      damage = Math.max(0, damage + targetActor.system.modifiers.slash_damage_affinity);
      stagger = Math.max(0, stagger + targetActor.system.modifiers.slash_stagger_affinity);
    } else if (payload.dieType === "pierce" || payload.dieType === "counter-pierce") {
      damage = Math.max(0, damage + targetActor.system.modifiers.pierce_damage_affinity);
      stagger = Math.max(0, stagger + targetActor.system.modifiers.pierce_stagger_affinity);
    } else {
      damage = Math.max(0, damage + targetActor.system.modifiers.blunt_damage_affinity);
      stagger = Math.max(0, stagger + targetActor.system.modifiers.blunt_stagger_affinity);
    }
    if (defenderType === "block" || defenderType === "counter-block") {
      damage = Math.max(0, damage - defenderRoll);
      stagger = Math.max(0, stagger - defenderRoll);
    }
    if (defenderType === "evade" || defenderType === "counter-evade") {
      stagger = Math.max(0, stagger - defenderRoll);
    }
  }

  if (payload.dieType === "block" || payload.dieType === "counter-block") {
    stagger = attack - defenderRoll // For the most microscopic of optimizations, we already know that attack > defenderRoll, so no need to Math.max
  }

  const curr_hp = targetActor.system.health.value;
  const curr_stagger = targetActor.system.stagger.value;
  const final_hp = curr_hp - damage
  const final_stagger = curr_stagger - stagger

  await targetActor.update({
    "system.health.value": final_hp,
    "system.stagger.value": final_stagger
  });
}