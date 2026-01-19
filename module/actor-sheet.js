import { EntitySheetHelper } from "./helper.js";
import {ATTRIBUTE_TYPES} from "./constants.js";

/**
 * Extend the basic ActorSheet with some very simple modifications
 * @extends {ActorSheet}
 */
export class SotCActorSheet extends ActorSheet {

  /** @inheritdoc */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["sotc", "sheet", "actor"],
      template: "systems/sotc/templates/actor-sheet.html",
      width: 600,
      height: 600,
      tabs: [{navSelector: ".sheet-tabs", contentSelector: ".sheet-body", initial: "summary"}],
      scrollY: [".biography", ".skills", "ego", ".summary", ".passives", ".statuses"]
    });
  }

  /* -------------------------------------------- */

  /** @inheritdoc */
  async getData(options) {
    const context = await super.getData(options);
    EntitySheetHelper.getAttributeData(context.data);
    context.shorthand = !!game.settings.get("sotc", "macroShorthand");
    context.systemData = context.data.system;
    context.dtypes = ATTRIBUTE_TYPES;

    // Define our item types
    context.skills = this.actor.items.filter(i => i.type === "skill");
    context.egos = this.actor.items.filter(i => i.type === "ego");
    context.statuses = this.actor.items.filter(i => i.type === "status");
    context.passives = this.actor.items.filter(i => i.type === "passive");

    // Make these elements from actor-sheet.html render properly. I'm not sure if I even need these, didn't I switch to prosemirrors?
    // Look at this idiot. Not a knower at all. Yeah they're prosemirrors, but they need to have some rendering done for v11-12 (and not for v13)
    const fv = game.version ?? game?.data?.version;
    const use_v13 = foundry.utils.isNewerVersion(fv, "12.999");
    if (use_v13) {
      context.biographyHTML = context.systemData.biography ?? "";
      context.battle1HTML = context.systemData.battle_ability_1?.details ?? "";
      context.battle2HTML = context.systemData.battle_ability_2?.details ?? "";
    } else {
      context.biographyHTML = await TextEditor.enrichHTML(context.systemData.biography ?? "", {async: true});
      context.battle1HTML = await TextEditor.enrichHTML(context.systemData.battle_ability_1?.details ?? "", {async: true});
      context.battle2HTML = await TextEditor.enrichHTML(context.systemData.battle_ability_2?.details ?? "", {async: true});
    }
    return context;
  }

  /* -------------------------------------------- */

  /** @inheritdoc */
  activateListeners(html) {
    super.activateListeners(html);

    // Everything below here is only needed if the sheet is editable
    if ( !this.isEditable ) return;

    // Attribute Management
    html.find(".attributes").on("click", ".attribute-control", EntitySheetHelper.onClickAttributeControl.bind(this));
    html.find(".groups").on("click", ".group-control", EntitySheetHelper.onClickAttributeGroupControl.bind(this));
    html.find(".attributes").on("click", "a.attribute-roll", EntitySheetHelper.onAttributeRoll.bind(this));

    // Skill Controls, which are also reused for EGOs
    html.find(".skill_card-control").click(this._onSkillControl.bind(this));
    html.find(".skill_roll-button").click(this._onRollFullSkill.bind(this));

    // Status Controls, basically the exact same as skill controls but I didn't make it modular because uhhh, lines of code are not my concern on this first instance
    html.find(".status_card-control").click(this._onStatusControl.bind(this));
    // But this one is different!
    html.find(".post_active-button").click(this._onPostActive.bind(this));
    // Haha! And a third one that is very similar!
    html.find(".passive_card-control").click(this._onPassiveControl.bind(this));

    html.find(".skill_card, .passive_card").each((i, card) => {
      card.addEventListener("dragstart", ev => this._onDragItem(ev));
    });

    // Time to uhh, finally implement the other part of the system. You can tell what this does, I hope
    html.find(".roll-might").click(ev => this._onAttributeRoll(ev, "might"));
    html.find(".roll-vitality").click(ev => this._onAttributeRoll(ev, "vitality"));
    html.find(".roll-agility").click(ev => this._onAttributeRoll(ev, "agility"));
    html.find(".roll-intellect").click(ev => this._onAttributeRoll(ev, "intellect"));
    html.find(".roll-instinct").click(ev => this._onAttributeRoll(ev, "instinct"));
    html.find(".roll-persona").click(ev => this._onAttributeRoll(ev, "persona"));

    html.find(".toggle_stagger").on("change", async ev => {
      const checkbox = ev.currentTarget;
      const itemId = checkbox.dataset.itemId;
      const item = this.actor.items.get(itemId);
      if (!item) return;

      const new_count = checkbox.checked ? 1 : 0;
      const old_count = item.system.count ?? 0;

      await item.update({ "system.count": new_count });

      if (old_count === 0 && new_count > 0) {
        const applied_round = game.combat?.round ?? 0;
        const duration = item.system.stagger_duration ?? 0;

        await item.update({
          "system.stagger_end": applied_round + duration + 1
        });
      }
    });

    /** 
     * The below function has been temporarily excised because I couldn't get the function it was supporting to work properly. This DID work fine... maybe... I don't know...
    // Swap display value when input is blurred/focused
    html.find(".derived-input").each(function () {
      const $input = $(this);

      function showDerived() {
        const derived = $input.data("derived");
        if (derived !== undefined) $input.val(derived);
      }

      function showRaw() {
        const base = $input.data("raw");
        if (base !== undefined) $input.val(base);
      }

      // When user changes the raw value, keep data-base in sync
      $input.on("change input", () => {
        // Only meaningful while focused on raw; still safe otherwise
        $input.data("base", $input.val());
      });

      $input.on("focus", showRaw);
      $input.on("blur", showDerived);

      // Start in derived display mode
      showDerived();
    });
    */
  }

  /* -------------------------------------------- */

  /**
   * Handle click events for Item control buttons within the Actor Sheet
   * @param event
   * @private
   */
  
  _onSkillControl(event) {
    event.preventDefault();
    const button = event.currentTarget;
    // Identify the button by its html div, I won't repeat this explanation for my future comments
    const card = button.closest(".skill_card");
    const itemId = card?.dataset.itemId;
    const item = this.actor.items.get(itemId);

    // Check for which button is used and in any given case
    if (button.classList.contains("add-skill_card")) {
      const cls = getDocumentClass("Item");
      return cls.create({name: game.i18n.localize("SOTC.ItemNew"), type: "skill", img: "systems/sotc/assets/Raw Ruina Assets/Pages/default skill icon.png"}, {parent: this.actor});
    } else if (button.classList.contains("add-ego_card")) {
      const cls = getDocumentClass("Item");
      return cls.create({name: game.i18n.localize("SOTC.ItemNew"), type: "ego", img: "systems/sotc/assets/Raw Ruina Assets/Pages/default skill icon.png"}, {parent: this.actor});
    }

    if (!item) {
      console.warn("How did you even manage this! This shouldn't be possible: Skill item not found:", itemId);
      return;
    }

    // Open up the sheet for the skill/ego that is being edited
    if (button.classList.contains("edit-skill_card")) {
      return item.sheet.render(true);
    }

    // This function is also meant to let you move your skills to the back of the list, for reorganizing since we currently can't drag them around
    if (button.classList.contains("duplicate-skill_card")) {
      const data = duplicate(item.toObject());
      delete data._id;
      return this.actor.createEmbeddedDocuments("Item", [data]);
    }

    // I should probably add a dialog option that gives a warning or requests a confirmation. Missclicking this would suck major major
    if (button.classList.contains("delete-skill_card")) {
      return Dialog.confirm({
        title: "Delete Status?",
        content: `<p>Are you sure you want to delete <strong>${item.name}</strong>?</p>`,
        yes: () => item.delete(),
        no: () => {},
        defaultYes: false,
      });
    }
  }

  /* -------------------------------------------- */

  async _onRollFullSkill(event) {
    event.preventDefault();
    const button = event.currentTarget;
    const card = button.closest(".skill_card");
    const itemId = card?.dataset.itemId;
    const item = this.actor.items.get(itemId);

    if (!item) {
      return ui.notifications.warn("Oh buddy, I don't know if this is worse than the other error. Your item is missing??? Tell me about it...");
    }
    // I fucked up somewhere along the line and have violated our template.json structure
    // So now we end up with an object storing our die instead of an array. I'll surely come back and fix this at some point, right? Haha.
    const diceObject = item.system.dice?.die ?? {};
    const diceArray = Array.isArray(diceObject) ? diceObject : Object.values(diceObject);
    if (!diceArray) {
      return ui.notifications.warn("WHAT ARE YOU DOING!!! Your skill has no dice array!!! How'd you even manage that!!! Tell me about it...");
    }

    // Prepare dialog content
    const dialogContent = await renderTemplate("systems/sotc/templates/skill-roll-dialog.html", {
      dice: diceArray
    });

    // There's a good chance that I could cut down on this, but right now it looks pretty good and works pretty well
    // Note that the individual rolls, as in item-sheet.js do not have any dialog box
    new Dialog({
      title: `Roll Skill: ${item.name}`,
      content: dialogContent,
      buttons: {
        declare: {
          icon: '<i class="fas fa-exclamation-circle"></i>',
          label: "Reveal",
          callback: async html => {
            const diceArray = item.system.dice?.die ?? {};
            const dice = Array.isArray(diceArray) ? diceArray : Object.values(diceArray);

            // Optional sections based on conditions
            const skillModules = item.system.skill_modules?.mods;
            const light_cost = item.system.light_cost;
            const light_costLine = `<p><strong>Light Cost:</strong> ${light_cost}</p>`;
            const weight = item.system.weight;
            const weightLine = weight > 1 ? `<p><strong>Attack Weight:</strong> ${weight}</p>` : "";
            const skillModulesLine = skillModules ? `<div class="skill-modules" style="white-space: pre-wrap;">${skillModules}</div>` : "";

            // Non-Optional. This is why you're printing the skill, obviously it's not optional? Are you stupid?
            const diceSummaries = dice.map(die => {
              const icon = `systems/sotc/assets/dice types/${die.type}.png`;
              const colorClass = `die-color-${die.type}`;
              const formula = die.formula;
              const modules = Object.values(die.mods ?? {});
              const moduleLine = modules.length
                ? `<div style="margin-top: 4px; font-size: 12px;"><em>${modules.map(m => `<div style="margin-left: 5px;">• ${m}</div>`).join("")}</em></div>`
                : "";
              return `
                <div style="margin-bottom: 5px;">
                  <span class="${colorClass}" style="vertical-align: middle; font-size: 16px; text-shadow: black 0.5px 0.5px">
                    <div style="display: flex; gap: 4px;">
                      <img src="${icon}" alt="${die.type}" title="${die.type}" style="height: 30px; width: 30px; vertical-align: middle; border: none;">
                      <strong style="margin-top: 4px;">${formula}</strong>
                    </div>
                  </span>
                  ${moduleLine ? `${moduleLine}` : ""}
                </div>
              `;
            }).join("");

            const messageContent = `
              <div class="skill-declaration">
                <h3>${item.name}</h3>
                ${light_costLine}
                ${weightLine}
                ${skillModulesLine}
                <p><strong>Dice:</strong></p>
                ${diceSummaries}
              </div>
            `;

            ChatMessage.create({
              speaker: ChatMessage.getSpeaker({ actor: this.actor }),
              content: messageContent,
              type: CONST.CHAT_MESSAGE_TYPES.OTHER
            });
          }
        },
        roll: {
          icon: '<i class="fas fa-dice"></i>',
          label: "Roll",
          callback: async html => {
            const diceArray = item.system.dice?.die ?? {};
            const dice = Array.isArray(diceArray) ? diceArray : Object.values(diceArray);
            const results = [];

            // Loop through each die and roll appropriately
            for (let i = 0; i < dice.length; i++) {
              const die = dice[i];
              const input = $(html).find(`[data-die-index="${i}"]`)[0];
              const mod = parseInt($(input).find(`input[name="mod-${i}"]`).val()) || 0;
              const paralysis = $(input).find(`input[name="paralysis-${i}"]`).prop("checked");
              const poise = $(input).find(`input[name="poise-${i}"]`).prop("checked");
              let status_mod = 0;

              // Parses any die of the format XdY+Z where Z can be any number of +/- terms
              const match = die.formula.match(/^\s*(\d+)\s*d\s*(\d+)((?:\s*[+-]\s*\d+)*)\s*$/);
              if (!match) {
                results.push({
                  die,
                  isError: true,
                  message: `Invalid formula: <code>${die.formula}</code>. Must be of the format XdY+Z`
                });
                continue;
              }

              // As it has already been checked above, we can now properly breakdown our stupid ass little formula into the relevant parts
              const numDice = parseInt(match[1]);
              const dieSize = parseInt(match[2]);
              const modifierString = match[3] || "";
              // Decypher the  string into individual parts so that MOST forms of equation won't fucking explode. If people <- apparently I ended this sentence right here. What?
              const baseMod = modifierString
                .replace(/\s+/g, "")
                .split(/(?=[+-])/)
                .filter(s => s.length)
                .reduce((sum, str) => sum + parseInt(str), 0);

              // Apply modifiers from status effects
              status_mod += this.actor.system.modifiers.all_mod;

              if (["slash", "pierce", "blunt", "counter-slash", "counter-pierce", "counter-blunt"].includes(die.type)) {
                status_mod += this.actor.system.modifiers.off_mod;
              }
              if (["block", "evade", "counter-block", "counter-evade"].includes(die.type)) {
                status_mod += this.actor.system.modifiers.def_mod;
              }
              if (["slash", "counter-slash"].includes(die.type)) {
                status_mod += this.actor.system.modifiers.slash_mod;
              }
              else if (["pierce", "counter-pierce"].includes(die.type)) {
                status_mod += this.actor.system.modifiers.pierce_mod;
              }
              else if (["blunt", "counter-blunt"].includes(die.type)) {
                status_mod += this.actor.system.modifiers.blunt_mod;
              }
              else if (["block", "counter-block"].includes(die.type)) {
                status_mod += this.actor.system.modifiers.block_mod;
              }
              else if (["evade", "counter-evade"].includes(die.type)) {
                status_mod += this.actor.system.modifiers.evade_mod;
              }

              let roll;
              let formulaForDisplay = "";

              if (mod > 0) {
                formulaForDisplay = `${formulaForDisplay} + ${mod}`;
              } else if (mod < 0) {
                formulaForDisplay = `${formulaForDisplay} - ${-mod}`;
              }
              if (status_mod > 0) {
                formulaForDisplay = `${formulaForDisplay} + ${status_mod}`;
              } else if (status_mod < 0) {
                formulaForDisplay = `${formulaForDisplay} - ${-status_mod}`;
              }

              // Currently, these are the only really non-module types of status effects. Maybe at some point I can make it apply more complicated specified logics
              if (paralysis) {
                let total = numDice * 1 + baseMod + mod + status_mod;
                // Stylistically show the paralysis or poise when its rolled.
                roll = await new Roll(`${total}`).roll({ async: true });
                formulaForDisplay = `${formulaForDisplay} = ${roll.total}`;
                formulaForDisplay = `<div style="display: flex;"><img src="systems/sotc/assets/statuses/Paralyze.png" title="Paralyze" style="height: 20px; width: 20px; vertical-align: middle; margin-right: 3px; border: none; filter: drop-shadow(1px 1px 2px black)">(${numDice}d${dieSize}) + ${baseMod}${formulaForDisplay}</div>`;
              } else if (poise) {
                let total = numDice * dieSize + baseMod + mod + status_mod;
                roll = await new Roll(`${total}`).roll({ async: true });
                formulaForDisplay = `${formulaForDisplay} = ${roll.total}`;
                formulaForDisplay = `<div style="display: flex;"><img src="systems/sotc/assets/statuses/Poise.png" title="Poise" style="height: 20px; width: 20px; vertical-align: middle; margin-right: 3px; border: none; filter: drop-shadow(1px 1px 2px black)">(${numDice}d${dieSize}) + ${baseMod}${formulaForDisplay}</div>`;
              } else {
                let formula = `${numDice}d${dieSize} + ${baseMod} + ${mod} + ${status_mod}`;
                // I've had it suggested that maybe this shouldn't be shown at all. I might take that into consideration eventually
                roll = await new Roll(formula).roll({ async: true });
                formulaForDisplay = `${formulaForDisplay} = ${roll.total}`;
                formulaForDisplay = `${numDice}d${dieSize} + ${baseMod}${formulaForDisplay}`;
              }

              results.push({die, roll, formulaForDisplay, mod, status_mod});
            }

            // Optional info: weight, modules
            const skillModules = item.system.skill_modules?.mods;
            const light_cost = item.system.light_cost;
            const light_costLine = `<p><strong>Light Cost:</strong> ${light_cost}</p>`;

            const weight = item.system.weight;

            const weightLine = weight > 1 ? `<p><strong>Attack Weight:</strong> ${weight}</p>` : "";
            const skillModulesLine = skillModules ? `<div class="skill-modules" style="white-space: pre-wrap;">${skillModules}</div>` : "";

            // Dice display
            const diceSummaries = results.map(({ die, roll, formulaForDisplay, mod, status_mod }) => {
              const icon = `systems/sotc/assets/dice types/${die.type}.png`;
              const colorClass = `die-color-${die.type}`;
              const modules = Object.values(die.mods ?? {});
              const moduleLine = modules.length
                ? `<div style="margin-top: 4px; font-size: 12px;"><em>${modules.map(m => `<div style="margin-left: 5px;">• ${m}</div>`).join("")}</em></div>`
                : "";
              const payload = {
                dieType: die.type,
                total: roll.total,
                actorId: this.actor.id,
                itemId: item.id,
                itemName: item.name,
                isOffensive: ["slash","pierce","blunt","counter-slash","counter-pierce","counter-blunt"].includes(die.type),
                isDefensive: ["block","evade","counter-block","counter-evade"].includes(die.type)
              };

              return `
                <div style="margin-bottom: 5px;">
                  <span class="${colorClass}" style="vertical-align: middle; font-size: 16px;">
                    <div style="display: flex; gap: 4px;">
                      <img src="${icon}" alt="${die.type}" title="${die.type}" style="height: 30px; width: 30px; vertical-align: middle; border: none;">
                      <strong style="text-shadow: black 0.5px 0.5px; margin-top: 4px;">${formulaForDisplay}</strong>
                      <a class="reroll-die" data-formula="${die.formula}" data-type="${die.type}"  title="Reroll die!"
                        data-actor-id="${this.actor.id}"
                        data-formula="${die.formula}"
                        data-mod="${mod}"
                        data-statmod="${status_mod}"
                        data-type="${die.type}"
                        data-color="die-color-${die.type}"
                        data-modules='${JSON.stringify(Object.values(die.mods ?? {}))}'
                        data-itemname="${item.name}"
                        style="width: 16px; height: 16px; color: black; margin-left: 8px; margin-top: 4px;">
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
              `;
            }).join("");

            const flavor = `
              <div class="skill-roll-summary">
                <h3>${item.name}</h3>
                ${light_costLine}
                ${weightLine}
                ${skillModulesLine}
                <p><strong>Dice Rolled:</strong></p>
                ${diceSummaries}
                <hr>
                <a class="toggle-roll-details" style="cursor: pointer; font-size: 12px; color: #888;">
                  ⯈ Show Roll Details
                </a>
              </div>
            `;

            let chatMessageId;

            Hooks.once("renderChatMessage", (message, html) => {
              if (message.id !== chatMessageId) return;

              const diceRolls = html.find(".dice-roll");
              if (diceRolls.length) {
                const wrapper = $(`<div class="roll-details-wrapper" style="display: none;"></div>`);
                diceRolls.wrapAll(wrapper);

                const toggleLink = html.find(".toggle-roll-details");
                toggleLink.on("click", () => {
                  const wasHidden = html.find(".roll-details-wrapper").is(":hidden");
                  html.find(".roll-details-wrapper").toggle();
                  toggleLink.html(wasHidden ? "⯆ Hide Roll Details" : "⯈ Show Roll Details");
                  toggleLink.toggleClass("open", wasHidden);
                });
              }
            });

            await (async () => {
              const actor = this.actor;
              if (actor) {
                const updates = {};

                // Light cost
                const lightCost = item.system.light_cost ?? 0;
                if (lightCost > 0) {
                  const currentLight = getProperty(actor.system, "light.value") ?? 0;
                  updates["system.light.value"] = Math.max(currentLight - lightCost, 0);
                }

                // Emotion cost
                const emotionCost = item.system.emotion_cost ?? 0;
                if (emotionCost > 0) {
                  const currentEmotion = getProperty(actor.system, "emotion") ?? 0;
                  updates["system.emotion"] = Math.max(currentEmotion - emotionCost, 0);
                }

                // Limited uses
                const maxUses = item.system.limit?.max ?? 0;
                if (maxUses > 0) {
                  const currentUses = item.system.limit?.value ?? maxUses;
                  const newUses = Math.max(currentUses - 1, 0);
                  await item.update({ "system.limit.value": newUses });
                }

                if (Object.keys(updates).length > 0) {
                  await actor.update(updates);
                }
              }
            })();

            const chatMessage = await ChatMessage.create({
              speaker: ChatMessage.getSpeaker({ actor: this.actor }),
              flavor,
              rolls: results.map(r => r.roll),
              type: CONST.CHAT_MESSAGE_TYPES.ROLL,
              rollMode: game.settings.get("core", "rollMode"),
              sound: CONFIG.sounds.dice
            });

            chatMessageId = chatMessage.id;
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel"
        }
      },
      default: "declare",

      // This handles our paralysis and poise icons so that those status effects can be applied
      render: html => {
        const root = html[0];
        root.querySelectorAll(".toggle_icon").forEach(icon => {
          icon.addEventListener("click", () => {
            const index = icon.dataset.index;
            const type = icon.dataset.type;

            const currentIcon = icon;
            const otherType = type === "paralysis" ? "poise" : "paralysis";
            const otherIcon = html[0].querySelector(`.toggle_icon[data-type="${otherType}"][data-index="${index}"]`);

            const currentInput = html[0].querySelector(`input[name="${type}-${index}"]`);
            const otherInput = html[0].querySelector(`input[name="${otherType}-${index}"]`);

            const isSelected = currentInput.checked;

            // Deselect both
            currentInput.checked = false;
            otherInput.checked = false;
            currentIcon.classList.remove("selected");
            otherIcon?.classList.remove("selected");

            // If it wasn't selected, select it (and ensure the other remains deselected)
            if (!isSelected) {
              currentInput.checked = true;
              currentIcon.classList.add("selected");
            }
          });
        });

        root.querySelectorAll(".dialog_individual_roll-button").forEach(btn => {
          btn.addEventListener("click", async ev => {
            ev.preventDefault();
            const i = parseInt(btn.dataset.index);
            const diceArray = item.system.dice?.die ?? {};
            const dice = Array.isArray(diceArray) ? diceArray : Object.values(diceArray);
            const die = dice[i];

            const input = root.querySelector(`[data-die-index="${i}"]`);
            const mod = parseInt(input.querySelector(`input[name="mod-${i}"]`)?.value) || 0;
            const paralysis = input.querySelector(`input[name="paralysis-${i}"]`)?.checked;
            const poise = input.querySelector(`input[name="poise-${i}"]`)?.checked;
            let status_mod = 0;

            // parse formula
            const match = die.formula.match(/^\s*(\d+)\s*d\s*(\d+)((?:\s*[+-]\s*\d+)*)\s*$/);
            if (!match) {
              return ui.notifications.error(`Invalid formula: ${die.formula}`);
            }

            const numDice = parseInt(match[1]);
            const dieSize = parseInt(match[2]);
            const modifierString = match[3] || "";
            const baseMod = modifierString
              .replace(/\s+/g, "")
              .split(/(?=[+-])/)
              .filter(s => s.length)
              .reduce((sum, str) => sum + parseInt(str), 0);

            // Apply modifiers from status effects
            status_mod += this.actor.system.modifiers.all_mod;

            if (["slash", "pierce", "blunt", "counter-slash", "counter-pierce", "counter-blunt"].includes(die.type)) {
              status_mod += this.actor.system.modifiers.off_mod;
            }
            if (["block", "evade", "counter-block", "counter-evade"].includes(die.type)) {
              status_mod += this.actor.system.modifiers.def_mod;
            }
            if (["slash", "counter-slash"].includes(die.type)) {
              status_mod += this.actor.system.modifiers.slash_mod;
            }
            else if (["pierce", "counter-pierce"].includes(die.type)) {
              status_mod += this.actor.system.modifiers.pierce_mod;
            }
            else if (["blunt", "counter-blunt"].includes(die.type)) {
              status_mod += this.actor.system.modifiers.blunt_mod;
            }
            else if (["block", "counter-block"].includes(die.type)) {
              status_mod += this.actor.system.modifiers.block_mod;
            }
            else if (["evade", "counter-evade"].includes(die.type)) {
              status_mod += this.actor.system.modifiers.evade_mod;
            }
              
            let roll;
            let formulaForDisplay = "";

            if (mod > 0) {
              formulaForDisplay = `${formulaForDisplay} + ${mod}`;
            } else if (mod < 0) {
              formulaForDisplay = `${formulaForDisplay} - ${-mod}`;
            }
            if (status_mod > 0) {
              formulaForDisplay = `${formulaForDisplay} + ${status_mod}`;
            } else if (status_mod < 0) {
              formulaForDisplay = `${formulaForDisplay} - ${-status_mod}`;
            }

            if (paralysis) {
              let total = numDice * 1 + baseMod + mod + status_mod;
              roll = await new Roll(`${total}`).roll({ async: true });
              formulaForDisplay = `${formulaForDisplay} = ${roll.total}`;
              formulaForDisplay = `<div style="display: flex;"><img src="systems/sotc/assets/statuses/Paralyze.png" title="Paralyze" style="height: 20px; width: 20px; vertical-align: middle; margin-right: 3px; border: none; filter: drop-shadow(1px 1px 2px black)">(${numDice}d${dieSize}) + ${baseMod}${formulaForDisplay}</div>`;
            } else if (poise) {
              let total = numDice * dieSize + baseMod + mod + status_mod;
              roll = await new Roll(`${total}`).roll({ async: true });
              formulaForDisplay = `${formulaForDisplay} = ${roll.total}`;
              formulaForDisplay = `<div style="display: flex;"><img src="systems/sotc/assets/statuses/Poise.png" title="Poise" style="height: 20px; width: 20px; vertical-align: middle; margin-right: 3px; border: none; filter: drop-shadow(1px 1px 2px black)">(${numDice}d${dieSize}) + ${baseMod}${formulaForDisplay}</div>`;
            } else {
              let formula = `${numDice}d${dieSize} + ${baseMod} + ${mod} + ${status_mod}`;
              // I've had it suggested that maybe this shouldn't be shown at all. I might take that into consideration eventually
              roll = await new Roll(formula).roll({ async: true });
              formulaForDisplay = `${formulaForDisplay} = ${roll.total}`;
              formulaForDisplay = `${numDice}d${dieSize} + ${baseMod}${formulaForDisplay}`;
            }

            // Module display
            const modules = Object.values(die.mods ?? {});
            const moduleLine = modules.length
              ? `<div style="margin-top: 4px; font-size: 12px;"><em>${modules.map(m => `<div style="margin-left: 5px;">• ${m}</div>`).join("")}</em></div>`
              : "";

            const payload = {
              dieType: die.type,
              total: roll.total,
              actorId: this.actor.id,
              itemId: item.id,
              itemName: item.name,
              isOffensive: ["slash","pierce","blunt","counter-slash","counter-pierce","counter-blunt"].includes(die.type),
              isDefensive: ["block","evade","counter-block","counter-evade"].includes(die.type)
            };

            const icon = `systems/sotc/assets/dice types/${die.type}.png`;
            const colorClass = `die-color-${die.type}`;
            const flavor = `
              <div class="skill-die-roll">
                <h3>${item.name}</h3>
                <div style="margin-left:5px; margin-bottom:5px;">
                  <span class="${colorClass}" style="margin-left: 5px; vertical-align: middle; font-size: 16px;">
                    <div style="display: flex; gap: 4px;">
                      <img src="${icon}" alt="${die.type}" style="height: 30px; width: 30px; vertical-align: middle; border: none;">
                      <strong style="text-shadow: black 0.5px 0.5px; margin-top: 4px;">${formulaForDisplay}</strong>
                      <a class="reroll-die" data-formula="${die.formula}" data-type="${die.type}"  title="Reroll this die"
                        data-actor-id="${this.actor.id}"
                        data-formula="${die.formula}"
                        data-mod=${mod}
                        data-statmod="${status_mod}"
                        data-type="${die.type}"
                        data-color="die-color-${die.type}"
                        data-modules='${JSON.stringify(Object.values(die.mods ?? {}))}'
                        data-itemname="${item.name}"
                        style="width: 16px; height: 16px; color: black; margin-left: 8px; margin-top: 4px;">
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
              speaker: ChatMessage.getSpeaker({ actor: this.actor }),
              flavor: flavor,
              rolls: [roll],
              type: CONST.CHAT_MESSAGE_TYPES.ROLL,
              rollMode: game.settings.get("core", "rollMode"),
              sound: CONFIG.sounds.dice
            });
          });
        });
      }
    }, {
      classes: ["sotc_skill_roll_dialog"]  // allows our custom black background styling
    }).render(true);
  }
  /* -------------------------------------------- */
  // Controls for our status buttons, basically just like the above with a modification for the status cards because the html formatting ain't vibing

  _onStatusControl(event) {
    event.preventDefault();
    const button = event.currentTarget;
    const card = button.closest(".status_card");
    const itemId = card?.dataset.itemId;
    const item = this.actor.items.get(itemId);

    if (button.classList.contains("add-status_card")) {
      // I'm almost certain that ther eis a better implementation than what I have. My code is what one might refer to as apish, in that I've typed out hamlet by smacking my head against the keyboard.
      // Lo and behold, for this is simple and just uh, references the html, and yeah, it's pretty simple.
      const container = button.closest(".buffs, .debuffs, .boons, .ailments, .other");
      let type = "buff"; // fallback which I really hope is never necessary. I've seriously fucked up if this comes into play BUT! uh, that's it...
      // For the sake of creating the new item in the correct category, determine the type of status
      if (container?.classList.contains("buffs")) type = "buff";
      else if (container?.classList.contains("debuffs")) type = "debuff";
      else if (container?.classList.contains("boons")) type = "boon";
      else if (container?.classList.contains("ailments")) type = "ailment";
      else if (container?.classList.contains("other")) type = "other";
      return this.actor.createEmbeddedDocuments("Item", [{name: game.i18n.localize("SOTC.ItemNew"),type: "status", img: "systems/sotc/assets/statuses/Default.png", system: {types: type}}]);
    }

    if (!item) {
      console.warn("How did you even manage this! This shouldn't be possible: Status item not found:", itemId);
      return;
    }

    if (button.classList.contains("edit-status_card")) {
      return item.sheet.render(true);
    }

    if (button.classList.contains("print-status_card")) {
      const sheet = item.sheet;
      if (sheet && typeof sheet._printStatus === "function") {
        return sheet._printStatus(event);
      }
      ui.notifications.warn("This status does not have a printable sheet.");
      return;
    }

    if (button.classList.contains("duplicate-status_card")) {
      const data = duplicate(item.toObject());
      delete data._id;
      return this.actor.createEmbeddedDocuments("Item", [data]);
    }

    if (button.classList.contains("delete-status_card")) {
      return Dialog.confirm({
        title: "Delete Status?",
        content: `<p>Are you sure you want to delete <strong>${item.name}</strong>?</p>`,
        yes: () => item.delete(),
        no: () => {},
        defaultYes: false,
      });
    }
  }

  _onPostActive(event) {
    event.preventDefault();
    const button = event.currentTarget;

    const itemId = button.dataset.itemId;
    const index = Number(button.dataset.index);
    const item = this.actor.items.get(itemId);

    if (!item) return console.warn("Post active: Item not found", itemId);

    const post_active = item.system.post_actives[index];
    if (!post_active) return console.warn("Post active: Index not found", index);

    // Trigger effect, like tremor burst or bleed or whatever you want
    const effect_type = item.system.effect;
    const flat_change = Number(item.system.potency_flat ?? 0)
    const potency = Number(item.system.potency ?? 1);
    const count = Number(item.system.count ?? 0);
    let delta = 0
    if (count) {
      delta = count * potency + flat_change;
    }
    const sign = effect_type === "Decrease" ? -1 : 1;

    const updates = {};
    // I know this could be more optimized, but I didn't want to ASSUME that somebody wouldn't come in here tampering with stuff and want things to be plainly modifiable.
    // So yeah this in particular is a little bit excessive, but it works fine
    if (post_active.operator === "sinking_deluge") {
      if (item.system.target !== "stagger") {
        console.log("Sinking Deluge is supposed to target stagger! Find actor-sheet.js lines ~780 if you wanna mess around.")
      } if (sign !== -1) {
        console.log("Sinking Deluge is supposed to SUBTRACT stagger! Find actor-sheet.js lines ~780 if you wanna mess around.")
      }
      const curr = this.actor.system.stagger.value;
      delta *= 3
      let hp_delta = 0
      hp_delta = Math.floor(Math.min(0, curr + delta * sign) / 2)
      if (hp_delta) {
        updates["system.stagger.value"] = 0
        updates["system.health.value"] = (this.actor.system.health.value ?? 0) + hp_delta
      } else {
        updates["system.stagger.value"] = (this.actor.system.stagger.value ?? 0) + (delta * sign);
      }
    } else {
      if (item.system.target === "hp" || item.system.target === "hp_stagger") {
        updates["system.health.value"] = (this.actor.system.health.value ?? 0) + (delta * sign);
      }
      if (item.system.target === "stagger" || item.system.target === "hp_stagger") {
        updates["system.stagger.value"] = (this.actor.system.stagger.value ?? 0) + (delta * sign);
      }
    }
    if (Object.keys(updates).length > 0) {
      this.actor.update(updates);
    }

    // Change count, according to variable. Generally either dividing or halving, but I can imagine a player wanting to do otherwise
    let new_count = count;
    const variable = Number(post_active.variable ?? 0);
    switch (post_active.operator) {
      case "add": new_count += variable; break;
      case "subtract": new_count -= variable; break;
      case "multiply": new_count *= variable; break;
      // Protect against division by 0 because we aren't dumb
      case "divide": new_count = variable !== 0 ? Math.floor(new_count / variable) : new_count; break;
      case "sinking_deluge": new_count = 0;
      case "maintain": break;
      default: console.warn("Unknown operator, how the heckle did you manage, man? Here it is:", post_active.operator);
    }

    // Prevent status count from becoming negative. Doesn't prevent the user from initially setting values to negative, I think
    new_count = Math.max(0, new_count)

    // Update the item
    return item.update({ "system.count": new_count });
  }

  /* -------------------------------------------- */
  // Passive buttons are pretty simple, all things considered. In a future implementation, they will be extended to biography tabs
  _onPassiveControl(event) {
    event.preventDefault();
    const button = event.currentTarget;
    const card = button.closest(".passive_card");
    const itemId = card?.dataset.itemId;
    const item = this.actor.items.get(itemId);

    if (button.classList.contains("add-passive_card")) {
      const cls = getDocumentClass("Item");
      return this.actor.createEmbeddedDocuments("Item", [{name: game.i18n.localize("SOTC.ItemNew"),type: "passive", system: {type: "passive"}}]);
    } else if (button.classList.contains("add-biography_card")) {
      const cls = getDocumentClass("Item");
      return this.actor.createEmbeddedDocuments("Item", [{name: game.i18n.localize("SOTC.ItemNew"),type: "passive", system: {type: "biography"}}]);
    }

    if (!item) {
      console.warn("How did you even manage this! This shouldn't be possible: Passive item not found:", itemId);
      return;
    }

    if (button.classList.contains("edit-passive_card")) {
      return item.sheet.render(true);
    }

    if (button.classList.contains("duplicate-passive_card")) {
      const data = duplicate(item.toObject());
      delete data._id;
      return this.actor.createEmbeddedDocuments("Item", [data]);
    }

    if (button.classList.contains("delete-passive_card")) {
      return Dialog.confirm({
        title: "Delete Status?",
        content: `<p>Are you sure you want to delete <strong>${item.name}</strong>?</p>`,
        yes: () => item.delete(),
        no: () => {},
        defaultYes: false,
      });
    }

    // Call helper (below) to print the passive details off. It's very simple all, considered
    if (button.classList.contains("print-passive_card")) {
      return this._printPassive(item);
    }
  }

  async _printPassive(item) {
    const name = item.name;
    const details = item.system.details ?? "";

    // Current styling is mundane, doesn't need to be complicated for now
    const content = `
      <div class="sotc-passive-card">
        <h3 style="margin:0; color: black; text-shadow: 1px 1px 2px white;">
          ${name}
        </h3>
        <div class="sotc-passive-details">${details}</div>
      </div>
    `;

    return ChatMessage.create({
      user: game.user.id,
      speaker: ChatMessage.getSpeaker({ actor: item.actor }),
      content
    });
  }

  /* -------------------------------------------- */
  // I rather shamelessly stole this. Please review it later to see if this STUFF (no cursing) actually works or how it actually works, me.
  // I went back and checked it, and I believe it works just fine. The logic of it is all sensible.
  /** @inheritdoc */
  async _updateObject(event, formData) {
    // The following blocks allow for addition and subtraction to the input fields that are most liable to change (I know that max stagger and health shouldn't change very often /
    // But even still if they're right next to a field that you can +/- a number in they may as well be consistent.
    const data = foundry.utils.deepClone(formData);

    // Choosing the select fields
    const numeric_fields = [
      "system.health.value",
      "system.health.max",
      "system.stagger.value",
      "system.stagger.max",
      "system.emotion"
    ];

    for (const path of numeric_fields) {
      if (!(path in data)) continue;

      const raw = String(data[path]).trim();
      if (!raw) continue;

      const current = Number(foundry.utils.getProperty(this.actor, path) ?? 0);

      // Lets algebraic inputs of +/-X be applied to the value
      if (/^[+-]\d+$/.test(raw)) {
        data[path] = current + Number(raw);
      }
      // Normal number overwrite
      else if (!isNaN(raw)) {
        data[path] = Number(raw);
      }
      // Disregard input if not a normal number of algebraic +/-X
      else {
        delete data[path];
      }
    }

    // Updates the actor with received form data
    const actor_data = foundry.utils.expandObject(data);
    await this.actor.update(actor_data);

    const updates = [];

    // Updates items on the actor sheet, such as for updating the count of statuses
    for (const [k, v] of Object.entries(data)) {
      // Tests that we're actually working with a real path
      const match = k.match(/^items\.(.+?)\.system\.(.+)$/);
      if (!match) continue;

      const itemId = match[1];
      const path = match[2];

      let update = updates.find(u => u._id === itemId);
      if (!update) {
        update = {_id: itemId, system: {}};
        updates.push(update);
      }

      foundry.utils.setProperty(update.system, path, v);
    }

    if (updates.length > 0) {
      await this.actor.updateEmbeddedDocuments("Item", updates);
    }
  }

  /**
   * Listen for roll buttons on items.
   * @param {MouseEvent} event
   */
  _onSkillRoll(event) {
    let button = $(event.currentTarget);
    const li = button.parents(".item");
    const item = this.actor.items.get(li.data("itemId"));
    let r = new Roll(button.data('roll'), this.actor.getRollData());
    return r.toMessage({
      user: game.user.id,
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      flavor: `<h3>${item.name}</h3><h3>${button.text()}</h3>`
    });
  }

  /* -------------------------------------------- */
  // The following two handle the rolling, first creating the dialog then rolling based on that dialog

  async _onAttributeRoll(event, attribute_key) {
    event.preventDefault();
    const actor = this.actor;
    const attribute = getProperty(actor.system, `attribute.${attribute_key}.value`) || 0;

    // Build dialog HTML
    const content = `
      <form class="test_dialog" style="background-color: black; color: #efc281; padding: 0px;">
        <div class="test_dialog_box" style="padding: 8px;">
          <h3>${attribute_key.charAt(0).toUpperCase() + attribute_key.slice(1)} Attempt</h3>
          <div style="text-align: center; margin-top: 8px; display: flex;">
            <span style="align-self: center;">Number of Dice: </span>
            <div style="flex: 1;display: flex;flex-direction: column;">
              <div class="flexrow">
                <span style="flex: 1; text-align: center;">1</span>
                <span style="flex: 1; text-align: center;"></span>
                <span style="flex: 1; text-align: center;">2</span>
                <span style="flex: 1; text-align: center;"></span>
                <span style="flex: 1; text-align: center;">3</span>
                <span style="flex: 1; text-align: center;"></span>
                <span style="flex: 1; text-align: center;">4</span>
              </div>
              <input type="range" class="num_attempts" min="1" max="4" value="1" style="background: transparent; height: 20px; width: 90%; margin: 0; align-self: center;">
            </div>
          </div>
        </div>
      </form>
    `;

    new Dialog({
      title: `${attribute_key.charAt(0).toUpperCase() + attribute_key.slice(1)} Attempt`,
      content,
      buttons: {
        roll: {
          label: "Roll",
          callback: async html => {
            const num_attempts = Number(html.find(".num_attempts").val()) || 1;
            await this._rollAttribute(attribute_key, attribute, num_attempts);
          }
        },
        cancel: { label: "Cancel" }
      },
      default: "roll"
    }, {
      classes: ["sotc_attribute_roll_dialog"]  // allows our custom black background styling
    }).render(true);
    
  }

  async _rollAttribute(attribute_key, attribute_value, num_attempts) {
    // Roll num_attempts d10s
    const roll = new Roll(`${num_attempts}d10`);
    await roll.evaluate({ async: true });

    // Collect results
    const results = roll.dice[0].results.map(r => r.result);
    const success = results.some(r => r <= attribute_value);

    const result_text = success ? '<b style="margin-bottom: 4px; color: #00aa00;">SUCCESS</b>' : '<b style="margin-bottom: 4px; color: #ff4444;">FAILURE</b>';

    const roll_HTML = await roll.render();

    // Build message
    const message = `
      <div class="attribute-roll">
        <h3>${attribute_key.charAt(0).toUpperCase() + attribute_key.slice(1)} Attempt</h3>
        <p>${num_attempts}d10 vs. ${attribute_key.charAt(0).toUpperCase() + attribute_key.slice(1)} (${attribute_value})</p>
        <p>Results: [ ${results.join(", ")} ]</p>
        ${result_text}
        ${roll_HTML}
      </div>
    `;

    const rollMode = game.settings.get("core", "rollMode");
    ChatMessage.create({
      user: game.user.id,
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content: message,
      rolls: [roll],
      type: CONST.CHAT_MESSAGE_TYPES.ROLL,
      whisper: rollMode === "private" || rollMode === "gmroll" ? ChatMessage.getWhisperRecipients("GM") : [],
      blind: rollMode === "blindroll",
    });
  }
  /* -------------------------------------------- */

  /** @inheritdoc */
  _getSubmitData(updateData) {
    let formData = super._getSubmitData(updateData);
    formData = EntitySheetHelper.updateAttributes(formData, this.object);
    formData = EntitySheetHelper.updateGroups(formData, this.object);
    return formData;
  }

  // This is a very, very, extremely basic start for item drag integration. No macro support yet. That stuff made me want to kms tbh ngl rn hahhhahha
  // mark the time, 3:02am. Saved and """ready""" to ship. Good luck users hahahhhah
  _onDragItem(event) {
    const itemId = event.currentTarget.dataset.itemId;
    if (!itemId) return;

    const item = this.actor.items.get(itemId);
    if (!item) return;

    event.dataTransfer.setData("text/plain", JSON.stringify({
      type: "Item",
      uuid: item.uuid,
      sotcCopy: true
    }));
  }

  async _onDrop(event) {
    const data = TextEditor.getDragEventData(event);

    // OUR custom copy behavior
    if (data?.type === "Item" && data.sotcCopy) {
      const sourceItem = await fromUuid(data.uuid);
      if (!sourceItem) return;

      if (sourceItem.parent?.id === this.actor.id) return;

      await this.actor.createEmbeddedDocuments("Item", [sourceItem.toObject()]);
      return;
    }

    // EVERYTHING ELSE → let Foundry handle it
    return super._onDrop(event);
  }
}