import { EntitySheetHelper } from "./helper.js";
import {ATTRIBUTE_TYPES} from "./constants.js";

/**
 * Extend the basic ItemSheet with some very simple modifications
 * @extends {ItemSheet}
 */
export class SotCSkillSheet extends ItemSheet {

  /** @inheritdoc */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["sotc", "sheet", "item", "skill", "ego"],
      template: "systems/sotc/templates/skill-sheet.html",
      width: 520,
      height: 480,
      resizable: false // This is a temporary solution to handle my own scope creep, sorry.
    });
  }

  /* -------------------------------------------- */

  /** @inheritdoc */
  async getData(options) {
    const context = await super.getData(options);
    if (context.data.img === "icons/svg/item-bag.svg") {
      context.data.img = "systems/sotc/assets/Raw Ruina Assets/Pages/default skill icon.png";
    }
    EntitySheetHelper.getAttributeData(context.data);
    context.systemData = context.data.system;
    context.sheetEditMode = this.item.getFlag("sotc", "sheetEditMode") || false;
    context.dtypes = ATTRIBUTE_TYPES;
    // Again again, not sure if I even need this but I don't want to test removing it. The commenting is easier than the removing it
    context.descriptionHTML = await TextEditor.enrichHTML(context.systemData.description, {
      secrets: this.document.isOwner,
      async: true
    });
    return context;
  }

  /* -------------------------------------------- */
  // Our skills are the prettiest, so I'm going to intensely document these
  /** @inheritdoc */
  activateListeners(html) {
    super.activateListeners(html);
    // For adding or removing dice
    html.find(".dice-control").click(this._onDiceControl.bind(this));
    // For adding and removing SKILL modules, currently not used
    html.find(".skill_modules-control").click(this._onSkillModControl.bind(this));
    // For adding and removing dice modules
    html.find(".dice_modules-control").click(this._onDiceModControl.bind(this));
    // To make the individual dice clickable, so that they can be recycled 
    html.find(".skill-die-button").click(this._onRollSkillDie.bind(this));
    // Make our skills editable
    html.find(".toggle-edit-mode").click(this._onToggleEditMode.bind(this));
    // Change our border colours, it's so pretty!!!
    html.find(".border-button").click(async ev => {
      const border = ev.currentTarget.dataset.border;
      await this.item.update({ "system.border_style": border });
    });
  }

  /* -------------------------------------------- */

  /** @override */
  _getSubmitData(updateData) {
    let formData = super._getSubmitData(updateData);
    formData = EntitySheetHelper.updateAttributes(formData, this.object);
    formData = EntitySheetHelper.updateGroups(formData, this.object);
    return formData;
  }

  /* -------------------------------------------- */

  /**
   * Add or remove a skill_modules from a skill. Currently we're not using this in any way because it looked ugly with the current implementation
   * At a later date I'll set this up so that the modules can have actual effects and this will then be useful
   * @param {Event} event             The original click event.
   * @returns {Promise<Item5e>|null}  Item with updates applied.
   * @private
   */

  async _onSkillModControl(event) {
    event.preventDefault();
    const a = event.currentTarget;
    const raw_mods = this.item.system.skill_modules.mods;
    const mods_array = Array.isArray(raw_mods) ? raw_mods : Object.values(raw_mods);
    console.log("Clicked skill_modules control:", a);

    // Add new skill_modules
    if ( a.classList.contains("add-skill_modules") ) {
      await this._onSubmit(event);  // Submit any unsaved changes
      const updated_mods_array = [...mods_array, ""];
      return this.item.update({"system.skill_modules.mods": updated_mods_array});
    }

    // Remove a skill_modules
    if ( a.classList.contains("delete-skill_modules") ) {
      await this._onSubmit(event);  // Submit any unsaved changes
      const li = a.closest(".skill_modules-mods");
      const index = Number(li.dataset.skill_modulesMods);
      const updated_mods_array = foundry.utils.deepClone(mods_array);
      updated_mods_array.splice(Number(li.dataset.skill_modulesMods), 1);
      return this.item.update({"system.skill_modules.mods": updated_mods_array});
    }
  }

  // Add a dice mod, so that the details can be printed on each dice when its rolled. Currently purely for visual effect and understanding
  async _onDiceModControl(event) {
    event.preventDefault();
    const a = event.currentTarget;
    await this._onSubmit(event);

    // Get the parent die container to extract the die index
    const container = a.closest(".dice-die");
    const die_index = Number(container?.dataset.diceDie);
    if (isNaN(die_index)) return console.warn("No valid die index found");

    // Normalize the dice data
    const raw_dice = this.item.system.dice.die;
    const dice_array = Array.isArray(raw_dice) ? raw_dice : Object.values(raw_dice || []);
    const die = foundry.utils.deepClone(dice_array[die_index]);
    const mods_array = Array.isArray(die.mods) ? die.mods : Object.values(die.mods || []);

    // Add new module
    if (a.classList.contains("add-dice_modules")) {
      mods_array.push("");
    }

    // Remove module
    if (a.classList.contains("delete-dice_modules")) {
      const li = a.closest(".dice_modules-mods");
      const mod_index = Number(li?.dataset.diceMod);
      if (!isNaN(mod_index)) mods_array.splice(mod_index, 1);
    }

    // Update only the specific die entry
    die.mods = mods_array;
    dice_array[die_index] = die;
    return this.item.update({ "system.dice.die": dice_array });
  }

  // Instate a generic control for dice that lets us do the adding and removing. I'm not actually a huge fan of the way this looks/works
  async _onDiceControl(event) {
    event.preventDefault();
    const a = event.currentTarget;
    const raw_die = this.item.system.dice.die;
    const die_array = Array.isArray(raw_die) ? raw_die : Object.values(raw_die);
    console.log("Clicked dice control:", a);

    // Add new dice
    if ( a.classList.contains("add-dice") ) {
      await this._onSubmit(event);
      const updated_die_array = [...die_array, { type: "slash", formula: "", effect: "" }];
      return this.item.update({"system.dice.die": updated_die_array});
    }

    // Remove a dice
    if ( a.classList.contains("delete-dice") ) {
      await this._onSubmit(event);
      const li = a.closest(".dice-die");
      const index = Number(li.dataset.diceDie);
      const updated_die_array = foundry.utils.deepClone(die_array);
      updated_die_array.splice(Number(li.dataset.diceDie), 1);
      return this.item.update({"system.dice.die": updated_die_array});
    }
  }

  /* -------------------------------------------- */
  // This would, ideally, allow us to fix the asset ratio for when resizing things so that the sheet remains all pretty and LOR looking. I didn't get it to work for this version, BUT
  // In the future, I should ocme back and get this to work since there are some goodd ideas here
  setPosition(options = {}) {
    // Call the original behavior first
    const pos = super.setPosition(options);

    // Enforce aspect ratio tgat keeps the border correctly sized
    const el = this.element[0];
    const aspectRatio = 1898 / 1500; // This is the correct ratio, which can be reasonably reduced but this is precise and accounts for border overflow onto the bar thingy at thte top

    const newWidth = el.offsetWidth;
    const newHeight = Math.round(newWidth / aspectRatio);

    el.style.height = `${newHeight}px`;

    return {
      ...pos,
      height: newHeight
    };
  }

  // How we roll the individual dice on a skill, for the purpose of recycling dice mainly or just for rerolling them. This provides no dialog box for power modification currently but should in the future
async _onRollSkillDie(event) {
  event.preventDefault();
  const index = Number(event.currentTarget.dataset.index);
  const die = this.item.system.dice.die[index];

  if (!die || !die.formula) {
    return ui.notifications.warn("No valid formula found for this die.");
  }

  try {
    let status_mod = 0;
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

    let roll_formula = die.formula;

    if (status_mod > 0) {
      roll_formula = `${roll_formula} + ${status_mod}`;
    } else if (status_mod < 0) {
      roll_formula = `${roll_formula} - ${-status_mod}`;
    }
    const roll = await new Roll(roll_formula).roll({ async: true });
    roll_formula = `${roll_formula} = ${roll.total}`;



    const icon = `systems/sotc/assets/dice types/${die.type}.png`;
    const colorClass = `die-color-${die.type}`;
    const modules = Object.values(die.mods ?? {});
    const moduleLine = modules.length
      ? `<div style="margin-top: 4px; font-size: 12px;"><em>${modules.map(m => `<div style="margin-left: 5px;">• ${m}</div>`).join("")}</em></div>`
      : "";
    



    const flavor = `
      <div class="skill-die-roll">
        <h3>${this.item.name}</h3>
        <div style="margin-left: 5px; margin-bottom: 5px;">
          <img src="${icon}" alt="${die.type}" title="${die.type}" style="height: 30px; width: 30px; vertical-align: middle; border: none;">
          <span class="${colorClass}" style="margin-left: 5px; vertical-align: middle; font-size: 16px;">
            <strong style="text-shadow: black 0.5px 0.5px">${roll_formula}</strong>
              <a class="reroll-die" data-formula="${die.formula}" data-type="${die.type}"  title="Reroll this die"
                data-formula="${die.formula}"
                data-mod="0"
                data-statmod="${status_mod}"
                data-type="${die.type}"
                data-color="die-color-${die.type}"
                data-modules='${JSON.stringify(Object.values(die.mods ?? {}))}'
                data-itemname="${this.item.name}"
                style="width: 16px; height: 16px; color: black; margin-left: 8px;">
                <i class="fas fa-rotate-left"></i>
              </a>
          </span>
          ${moduleLine ? `<br>${moduleLine}` : ""}
        </div>
      </div>
    `;

    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      flavor,
      sound: CONFIG.sounds.dice
    });

  } catch (err) {
    console.error("Error rolling die:", err);
    ui.notifications.error("Invalid formula. Please check your input.");
  }
}

  /* -------------------------------------------- */

  async _onToggleEditMode(event) {
    event.preventDefault();

    // Save current form values if switching from edit mode
    if (this.item.getFlag("sotc", "sheetEditMode")) {
      await this._onSubmit(event); // Save the form data
    }

    const current = this.item.getFlag("sotc", "sheetEditMode") || false;
    await this.item.setFlag("sotc", "sheetEditMode", !current);
    this.render();
  }
}