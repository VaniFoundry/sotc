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
      for (let c of combatants) {
        const actor_formula = c.actor?.system?.speed_dice?.dice_size;
        const actor_type = c.actor?.system?.initiative_type;
        const init_mod = c.actor?.system?.modifiers.speed_mod ?? 0;
        let total_formula = `${actor_formula}`;
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

        const roll = await new Roll(final_formula).roll({ async: true });
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
 */
Hooks.on("hotbarDrop", (bar, data, slot) => createSotCMacro(data, slot));

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
  for (const li of html[0].querySelectorAll(".combatant")) {
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

    if (combatant.isOwner || game.user.isGM) {
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
  // Now, we let each machine conduct this step, checking to see if they made the combatant. If not, they do nothing, and if so they make the duplicates!
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

  // You had to start with 1 combatant already to get more, obv
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
});

Hooks.on("deleteCombatant", async (combatant, options, userId) => {
  console.log("Combatant deleted", combatant);
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

// New scene, new initiative! We don't currently preserve the previous round's initiative which SUCKS for the sake of accidentally skipping a round
Hooks.on("combatRound", async (combat, round) => {
  console.log("Starting new round: resetting all speed dice initiative");

  const updates = [];

  for (let c of combat.combatants) {
    const actor = c.actor;
    if (!actor?.system?.speed_dice) continue; // I don't really know WHY we would, but in case you're using an actor in combat with no speed dice then uhhh, yeah?

    updates.push({
      _id: c.id,
      initiative: null,
      'flags.sotc.used': false  // Optionally reset the "used" marker
    });
  }

  if (updates.length > 0) {
    await combat.updateEmbeddedDocuments("Combatant", updates);
  }
});

Hooks.once("init", () => {
  CONFIG.statusEffects = [];
});

// We provide several modifications here in order to add status effects onto our tokens. Looks nice, is a bad implementation. We should ideally hook this into the original status effects
Hooks.once("ready", () => {
  // Keep a handle to the original method
  const _origDrawEffects = Token.prototype.drawEffects;

  // Patch drawEffects to add our custom status icons (items of type "status" with count > 0)
  Token.prototype.drawEffects = async function () {
    // Do the normal Foundry drawing first, which is currently nothing because we have nuked the default status effects from the existence. The exception is DEATH from the initiative tracker
    await _origDrawEffects.call(this);

    // Remove any previously drawn statuses
    if (this._sotcStatusIcons && Array.isArray(this._sotcStatusIcons)) {
      for (const entry of this._sotcStatusIcons) {
        if (entry?.container?.parent) this.effects.removeChild(entry.container);
      }
    }
    this._sotcStatusIcons = [];

    const actor = this.actor;
    if (!actor) return;

    // All status items with count > 0
    const statuses = actor.items.filter(i => i.type === "status" && (i.system?.count ?? 0) > 0);
    if (!statuses.length) return;

    const gridSize = canvas.grid.size; 
    const iconSize = Math.floor(gridSize * 0.24);
    const pad = 2;
    const wrapHeight = this.h; // wrap to next column if we run out of vertical space

    // This starts us in the upper left, but if we wanted to maybe change orientation and arrange it like Ruina status effects, maybe I could do that later
    let colX = pad;
    let y = pad;

    for (const st of statuses) {
      const imgPath = st.img || "icons/svg/aura.svg";
      const count = Number(st.system.count) || 0;

      // Container for icon + counter
      const container = new PIXI.Container();

      // Load the status token
      const tex = await loadTexture(imgPath);
      const sprite = new PIXI.Sprite(tex);
      sprite.width = sprite.height = iconSize;
      sprite.x = 0;
      sprite.y = 0;
      container.addChild(sprite);

      // Bottom-left count display
      if (count > 0) {
        const style = new PIXI.TextStyle({
          fontSize: Math.floor(iconSize * 0.4),
          fill: 0xFFFFFF,
          stroke: 0x000000,
          strokeThickness: 4,
          fontWeight: "900",
          align: "left"
        });
        const badge = new PIXI.Text(String(count), style);
        badge.anchor.set(0, 1);
        badge.x = 0;
        badge.y = iconSize + 3;
        container.addChild(badge);
      }

      // Place container
      container.x = colX;
      container.y = y;

      // Add to the token's effects container
      this.effects.addChild(container);
      this._sotcStatusIcons.push({ id: st.id, container });

      // Positioning, as with above we can manipulate this if we wanted to change the positionin
      y += iconSize + pad;
      if (y + iconSize > wrapHeight) {
        y = pad;
        colX += iconSize + pad;
      }
    }
  };

  // Helper to redraw all active tokens for an actor
  function redrawActorTokens(actor) {
    if (!actor) return;
    for (const token of actor.getActiveTokens()) {
      token.drawEffects();
    }
  }

  // Redraw when a status item changes/appears/disappears
  Hooks.on("updateItem", (item, diff) => {
    if (item.type !== "status") return;
    // If count or img changed, redraw (count drives visibility + number)
    if (diff?.system?.count !== undefined || diff?.img !== undefined) {
      redrawActorTokens(item.actor);
    }
  });

  Hooks.on("createItem", (item) => {
    if (item.type === "status") redrawActorTokens(item.actor);
  });

  Hooks.on("deleteItem", (item) => {
    if (item.type === "status") redrawActorTokens(item.actor);
  });

  // Also redraw when a token is controlled or released (optional but helps responsiveness)
  Hooks.on("controlToken", (token) => token?.drawEffects?.());
});

Hooks.on("renderTokenHUD", (hud, html, data) => {
  // Remove the default Foundry status effects button
  html.find('[data-action="effects"]').remove();
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

      const messageContent = `
        <div class="skill-die-roll">
          <h3>${item_name} - Reroll ${type}</h3>
          <div style="margin-left:5px;margin-bottom:5px;">
            <img src="${icon}" alt="${type}" style="height: 30px; width: 30px; vertical-align: middle; border: none;">
            <span class="${colorClass}" style="margin-left: 5px; vertical-align: middle; font-size: 16px;">
              <strong style="text-shadow: black 0.5px 0.5px">${total} = ${roll.total}</strong>
              <a class="reroll-die"
                data-formula="${formula}"
                data-type="${type}"
                data-mod="${mod}"
                data-statmod="${status_mod}"
                data-color="${colorClass}"
                data-modules='${JSON.stringify(modules)}'
                data-itemname="${item_name}"
                title="Reroll this die" 
                style="width: 16px; height: 16px; color: black; margin-left: 8px;">
                <i class="fas fa-rotate-left"></i>
              </a>
            </span>
            ${moduleLine ? `<br>${moduleLine}` : ""}
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
      ui.notifications.error("Could not reroll this die.");
    }
  });
});