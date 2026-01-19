import { EntitySheetHelper } from "./helper.js";

/**
 * Extend the base Actor document to support attributes and groups with a custom template creation dialog.
 * That above line is legacy Atropos documentation. Now, in addition, actor.js has... uh not that much that the original didn't do. Almost nothing
 * @extends {Actor}
 */
export class SotCActor extends Actor {
  static get defaultType() {
    return "character";
  }

  /** @inheritdoc */
  prepareDerivedData() {
    super.prepareDerivedData();

    // Ensure type is set, and specifically make it a character because CURRENTLY we don't have NPCs, but we'll change that later
    if (!this.type) this.updateSource({ type: "character" });

    this.system.groups = this.system.groups || {};
    this.system.attributes = this.system.attributes || {};
    EntitySheetHelper.clampResourceValues(this.system.attributes);
  
    const system = this.system;
    const modifiers = {
      all_mod: 0,
      off_mod: 0,
      def_mod: 0,
      slash_mod: 0,
      pierce_mod: 0,
      blunt_mod: 0,
      block_mod: 0,
      evade_mod: 0,
      speed_mod: 0,
      light_regen_mod: 0,
      slash_damage_affinity: system.affinities.damage_slash,
      slash_stagger_affinity: system.affinities.stagger_slash,
      pierce_damage_affinity: system.affinities.damage_pierce,
      pierce_stagger_affinity: system.affinities.stagger_pierce,
      blunt_damage_affinity: system.affinities.damage_blunt,
      blunt_stagger_affinity: system.affinities.stagger_blunt,
      null_light_regen: false,
      null_speed_dice: false,
      reset_stagger: false
    };

    const stagger_statuses = this.items.filter(i => i.type === "status" && (i.system.condition === "stagger_like") && (i.system.count > 0));
    for (const stag_stat of stagger_statuses) {
      const { null_light_regen, null_speed_dice, null_affinities, reset_stagger } = stag_stat.system.stagger_effects;
      if (null_light_regen) {
        modifiers.null_light_regen = null_light_regen
      }
      if (null_speed_dice) {
        modifiers.null_speed_dice = null_speed_dice
      }
      if (null_affinities) {
        modifiers.slash_damage_affinity = Math.max(0, modifiers.slash_damage_affinity),
        modifiers.slash_stagger_affinity = Math.max(0, modifiers.slash_stagger_affinity),
        modifiers.pierce_damage_affinity = Math.max(0, modifiers.pierce_damage_affinity),
        modifiers.pierce_stagger_affinity = Math.max(0, modifiers.pierce_stagger_affinity),
        modifiers.blunt_damage_affinity = Math.max(0, modifiers.blunt_damage_affinity),
        modifiers.blunt_stagger_affinity = Math.max(0, modifiers.blunt_stagger_affinity)
      }
      if (reset_stagger) {
        modifiers.reset_stagger = reset_stagger
      }
    }

    const statuses = this.items.filter(i => i.type === "status" && (i.system.condition === "passive") && (i.system.count > 0));

    for (const status of statuses) {
      const { effect, target, potency_flat = 0, potency = 0, count = 0 } = status.system;
      const sign = effect === "Increase" ? 1 : -1;
      const bonus = (potency_flat + potency * count) * sign;

      switch (target) {
        case "all dice power": modifiers.all_mod += bonus; break;
        case "offensive power": modifiers.off_mod += bonus; break;
        case "defensive power": modifiers.def_mod += bonus; break;
        case "slash power": modifiers.slash_mod += bonus; break;
        case "pierce power": modifiers.pierce_mod += bonus; break;
        case "blunt power": modifiers.blunt_mod += bonus; break;
        case "block power": modifiers.block_mod += bonus; break;
        case "evade power": modifiers.evade_mod += bonus; break;
        case "speed": modifiers.speed_mod += bonus; break;
        case "damage affinities": {
          modifiers.slash_damage_affinity += bonus;
          modifiers.blunt_damage_affinity += bonus;
          modifiers.pierce_damage_affinity += bonus; break;
        }
        case "stagger affinities": {
          modifiers.slash_stagger_affinity += bonus;
          modifiers.blunt_stagger_affinity += bonus;
          modifiers.pierce_stagger_affinity += bonus; break;
        }
        case "damage and stagger affinities": {
          modifiers.slash_damage_affinity += bonus;
          modifiers.blunt_damage_affinity += bonus;
          modifiers.pierce_damage_affinity += bonus;
          modifiers.slash_stagger_affinity += bonus;
          modifiers.blunt_stagger_affinity += bonus;
          modifiers.pierce_stagger_affinity += bonus; break;
        }
        case "slash damage affinity": modifiers.slash_damage_affinity += bonus; break;
        case "slash stagger affinity": modifiers.slash_stagger_affinity += bonus; break;
        case "slash damage and stagger affinity": {
          modifiers.slash_damage_affinity += bonus;
          modifiers.slash_stagger_affinity += bonus; break;
        }
        case "pierce damage affinity": modifiers.pierce_damage_affinity += bonus; break;
        case "pierce stagger affinity": modifiers.pierce_stagger_affinity += bonus; break;
        case "pierce damage and stagger affinity": {
          modifiers.pierce_damage_affinity += bonus;
          modifiers.pierce_stagger_affinity += bonus; break;
        }
        case "blunt damage affinity": modifiers.blunt_damage_affinity += bonus; break;
        case "blunt stagger affinity": modifiers.blunt_stagger_affinity += bonus; break;
        case "blunt damage and stagger affinity": {
          modifiers.blunt_damage_affinity += bonus;
          modifiers.blunt_stagger_affinity += bonus; break;
        }
        case "light regen": {
          modifiers.light_regen_mod += bonus; break;
        }
      }
    }

    // Store modifiers in system
    system.modifiers = modifiers;
  }

  /* -------------------------------------------- */

  /** @override */
  static async createDialog(data={}, options={}) {
    return EntitySheetHelper.createDialog.call(this, data, options);
  }

  /* -------------------------------------------- */

  /**
   * Is this Actor used as a template for other Actors?
   * @type {boolean}
   */
  get isTemplate() {
    return !!this.getFlag("sotc", "isTemplate");
  }

  /* -------------------------------------------- */
  /*  Roll Data Preparation                       */
  /* -------------------------------------------- */

  /** @inheritdoc */
  getRollData() {

    // Copy the actor's system data
    const data = this.toObject(false).system;
    const shorthand = game.settings.get("sotc", "macroShorthand");
    const formulaAttributes = [];
    const itemAttributes = [];

    // Handle formula attributes when the short syntax is disabled.
    this._applyShorthand(data, formulaAttributes, shorthand);

    // Map all item data using their slugified names
    this._applyItems(data, itemAttributes, shorthand);

    // Evaluate formula replacements on items.
    this._applyItemsFormulaReplacements(data, itemAttributes, shorthand);

    // Evaluate formula attributes after all other attributes have been handled, including items.
    this._applyFormulaReplacements(data, formulaAttributes, shorthand);

    // Remove the attributes if necessary.
    if ( !!shorthand ) {
      delete data.attributes;
      delete data.attr;
      delete data.groups;
    }
    return data;
  }

  /* -------------------------------------------- */

  /**
   * Apply shorthand syntax to actor roll data.
   * @param {Object} data The actor's data object.
   * @param {Array} formulaAttributes Array of attributes that are derived formulas.
   * @param {Boolean} shorthand Whether or not the shorthand syntax is used.
   */
  _applyShorthand(data, formulaAttributes, shorthand) {
    // Handle formula attributes when the short syntax is disabled.
    for ( let [k, v] of Object.entries(data.attributes || {}) ) {
      // Make an array of formula attributes for later reference.
      if ( v.dtype === "Formula" ) formulaAttributes.push(k);
      // Add shortened version of the attributes.
      if ( !!shorthand ) {
        if ( !(k in data) ) {
          // Non-grouped attributes.
          if ( v.dtype ) {
            data[k] = v.value;
          }
          // Grouped attributes.
          else {
            data[k] = {};
            for ( let [gk, gv] of Object.entries(v) ) {
              data[k][gk] = gv.value;
              if ( gv.dtype === "Formula" ) formulaAttributes.push(`${k}.${gk}`);
            }
          }
        }
      }
    }
  }

  /* -------------------------------------------- */

  /**
   * Add items to the actor roll data object. Handles regular and shorthand
   * syntax, and calculates derived formula attributes on the items.
   * @param {Object} data The actor's data object.
   * @param {string[]} itemAttributes
   * @param {Boolean} shorthand Whether or not the shorthand syntax is used.
   */
  _applyItems(data, itemAttributes, shorthand) {
    // Map all items data using their slugified names
    data.items = this.items.reduce((obj, item) => {
      const key = item.name.slugify({strict: true});
      const itemData = item.toObject(false).system;

      // Add items to shorthand and note which ones are formula attributes.
      for ( let [k, v] of Object.entries(itemData.attributes) ) {
        // When building the attribute list, prepend the item name for later use.
        if ( v.dtype === "Formula" ) itemAttributes.push(`${key}..${k}`);
        // Add shortened version of the attributes.
        if ( !!shorthand ) {
          if ( !(k in itemData) ) {
            // Non-grouped item attributes.
            if ( v.dtype ) {
              itemData[k] = v.value;
            }
            // Grouped item attributes.
            else {
              if ( !itemData[k] ) itemData[k] = {};
              for ( let [gk, gv] of Object.entries(v) ) {
                itemData[k][gk] = gv.value;
                if ( gv.dtype === "Formula" ) itemAttributes.push(`${key}..${k}.${gk}`);
              }
            }
          }
        }
        // Handle non-shorthand version of grouped attributes.
        else {
          if ( !v.dtype ) {
            if ( !itemData[k] ) itemData[k] = {};
            for ( let [gk, gv] of Object.entries(v) ) {
              itemData[k][gk] = gv.value;
              if ( gv.dtype === "Formula" ) itemAttributes.push(`${key}..${k}.${gk}`);
            }
          }
        }
      }

      // Delete the original attributes key if using the shorthand syntax.
      if ( !!shorthand ) {
        delete itemData.attributes;
      }
      obj[key] = itemData;
      return obj;
    }, {});
  }

  /* -------------------------------------------- */

  _applyItemsFormulaReplacements(data, itemAttributes, shorthand) {
    for ( let k of itemAttributes ) {
      // Get the item name and separate the key.
      let item = null;
      let itemKey = k.split('..');
      item = itemKey[0];
      k = itemKey[1];

      // Handle group keys.
      let gk = null;
      if ( k.includes('.') ) {
        let attrKey = k.split('.');
        k = attrKey[0];
        gk = attrKey[1];
      }

      let formula = '';
      if ( !!shorthand ) {
        // Handle grouped attributes first.
        if ( data.items[item][k]?.[gk] !== undefined ) {
          formula = data.items[item][k][gk].replace('@item.', `@items.${item}.`);
          data.items[item][k][gk] = Roll.replaceFormulaData(formula, data);
        }
        // Handle non-grouped attributes.
        else if ( data.items[item][k] ) {
          formula = data.items[item][k].replace('@item.', `@items.${item}.`);
          data.items[item][k] = Roll.replaceFormulaData(formula, data);
        }
      }
      else {
        // Handle grouped attributes first.
        if ( data.items[item]['attributes'][k][gk] ) {
          formula = data.items[item]['attributes'][k][gk]['value'].replace('@item.', `@items.${item}.attributes.`);
          data.items[item]['attributes'][k][gk]['value'] = Roll.replaceFormulaData(formula, data);
        }
        // Handle non-grouped attributes.
        else if ( data.items[item]['attributes'][k]['value'] ) {
          formula = data.items[item]['attributes'][k]['value'].replace('@item.', `@items.${item}.attributes.`);
          data.items[item]['attributes'][k]['value'] = Roll.replaceFormulaData(formula, data);
        }
      }
    }
  }

  /* -------------------------------------------- */

  /**
   * Apply replacements for derived formula attributes.
   * @param {Object} data The actor's data object.
   * @param {Array} formulaAttributes Array of attributes that are derived formulas.
   * @param {Boolean} shorthand Whether or not the shorthand syntax is used.
   */
  _applyFormulaReplacements(data, formulaAttributes, shorthand) {
    // Evaluate formula attributes after all other attributes have been handled, including items.
    for ( let k of formulaAttributes ) {
      // Grouped attributes are included as `group.attr`, so we need to split them into new keys.
      let attr = null;
      if ( k.includes('.') ) {
        let attrKey = k.split('.');
        k = attrKey[0];
        attr = attrKey[1];
      }
      // Non-grouped attributes.
      if ( data.attributes[k]?.value ) {
        data.attributes[k].value = Roll.replaceFormulaData(String(data.attributes[k].value), data);
      }
      // Grouped attributes.
      else if ( attr ) {
        data.attributes[k][attr].value = Roll.replaceFormulaData(String(data.attributes[k][attr].value), data);
      }

      // Duplicate values to shorthand.
      if ( !!shorthand ) {
        // Non-grouped attributes.
        if ( data.attributes[k]?.value ) {
          data[k] = data.attributes[k].value;
        }
        // Grouped attributes.
        else {
          if ( attr ) {
            // Initialize a group key in case it doesn't exist.
            if ( !data[k] ) {
              data[k] = {};
            }
            data[k][attr] = data.attributes[k][attr].value;
          }
        }
      }
    }
  }

  /* -------------------------------------------- */

  /** @inheritdoc */
  async modifyTokenAttribute(attribute, value, isDelta = false, isBar = true) {
    const current = foundry.utils.getProperty(this.system, attribute);
    if ( !isBar || !isDelta || (current?.dtype !== "Resource") ) {
      return super.modifyTokenAttribute(attribute, value, isDelta, isBar);
    }
    const updates = {[`system.${attribute}.value`]: Math.clamp(current.value + value, current.min, current.max)};
    const allowed = Hooks.call("modifyTokenAttribute", {attribute, value, isDelta, isBar}, updates);
    return allowed !== false ? this.update(updates) : this;
  }

  /* -------------------------------------------- */

}
