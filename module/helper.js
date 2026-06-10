
export class EntitySheetHelper {

  static getAttributeData(data) {

    // Determine attribute type.
    for ( let attr of Object.values(data.system.attributes) ) {
      if ( attr.dtype ) {
        attr.isCheckbox = attr.dtype === "Boolean";
        attr.isResource = attr.dtype === "Resource";
        attr.isFormula = attr.dtype === "Formula";
      }
    }

    // Initialize ungrouped attributes for later.
    data.system.ungroupedAttributes = {};

    // Build an array of sorted group keys.
    const groups = data.system.groups || {};
    let groupKeys = Object.keys(groups).sort((a, b) => {
      let aSort = groups[a].label ?? a;
      let bSort = groups[b].label ?? b;
      return aSort.localeCompare(bSort);
    });

    // Iterate over the sorted groups to add their attributes.
    for ( let key of groupKeys ) {
      let group = data.system.attributes[key] || {};

      // Initialize the attributes container for this group.
      if ( !data.system.groups[key]['attributes'] ) data.system.groups[key]['attributes'] = {};

      // Sort the attributes within the group, and then iterate over them.
      Object.keys(group).sort((a, b) => a.localeCompare(b)).forEach(attr => {
        // Avoid errors if this is an invalid group.
        if ( typeof group[attr] != "object" || !group[attr]) return;
        // For each attribute, determine whether it's a checkbox or resource, and then add it to the group's attributes list.
        group[attr]['isCheckbox'] = group[attr]['dtype'] === 'Boolean';
        group[attr]['isResource'] = group[attr]['dtype'] === 'Resource';
        group[attr]['isFormula'] = group[attr]['dtype'] === 'Formula';
        data.system.groups[key]['attributes'][attr] = group[attr];
      });
    }

    // Sort the remaining attributes.
    const keys = Object.keys(data.system.attributes).filter(a => !groupKeys.includes(a));
    keys.sort((a, b) => a.localeCompare(b));
    for ( const key of keys ) data.system.ungroupedAttributes[key] = data.system.attributes[key];

    // Modify attributes on items.
    if ( data.items ) {
      data.items.forEach(item => {
        // Iterate over attributes.
        for ( let [k, v] of Object.entries(item.system.attributes) ) {
          // Grouped attributes.
          if ( !v.dtype ) {
            for ( let [gk, gv] of Object.entries(v) ) {
              if ( gv.dtype ) {
                // Add label fallback.
                if ( !gv.label ) gv.label = gk;
                // Add formula bool.
                if ( gv.dtype === "Formula" ) {
                  gv.isFormula = true;
                }
                else {
                  gv.isFormula = false;
                }
              }
            }
          }
          // Ungrouped attributes.
          else {
            // Add label fallback.
            if ( !v.label ) v.label = k;
            // Add formula bool.
            if ( v.dtype === "Formula" ) {
              v.isFormula = true;
            }
            else {
              v.isFormula = false;
            }
          }
        }
      });
    }
  }

  /* -------------------------------------------- */

  /** @override */
  static onSubmit(event) {
    // Closing the form/sheet will also trigger a submit, so only evaluate if this is an event.
    if ( event.currentTarget ) {
      // Exit early if this isn't a named attribute.
      if ( (event.currentTarget.tagName.toLowerCase() === 'input') && !event.currentTarget.hasAttribute('name')) {
        return false;
      }

      let attr = false;
      // If this is the attribute key, we need to make a note of it so that we can restore focus when its recreated.
      const el = event.currentTarget;
      if ( el.classList.contains("attribute-key") ) {
        let val = el.value;
        let oldVal = el.closest(".attribute").dataset.attribute;
        let attrError = false;
        // Prevent attributes that already exist as groups.
        let groups = document.querySelectorAll('.group-key');
        for ( let i = 0; i < groups.length; i++ ) {
          if (groups[i].value === val) {
            ui.notifications.error(game.i18n.localize("SOTC.NotifyAttrDuplicate") + ` (${val})`);
            el.value = oldVal;
            attrError = true;
            break;
          }
        }
        // Handle value and name replacement otherwise.
        if ( !attrError ) {
          oldVal = oldVal.includes('.') ? oldVal.split('.')[1] : oldVal;
          attr = $(el).attr('name').replace(oldVal, val);
        }
      }

      // Return the attribute key if set, or true to confirm the submission should be triggered.
      return attr ? attr : true;
    }
  }

  /* -------------------------------------------- */

  /**
   * Listen for click events on an attribute control to modify the composition of attributes in the sheet
   * @param {MouseEvent} event    The originating left click event
   */
  static async onClickAttributeControl(event) {
    event.preventDefault();
    const a = event.currentTarget;
    const action = a.dataset.action;
    switch ( action ) {
      case "create":
        return EntitySheetHelper.createAttribute(event, this);
      case "delete":
        return EntitySheetHelper.deleteAttribute(event, this);
    }
  }

  /* -------------------------------------------- */

  /**
   * My shitty little addition that listens for a click on the add dice button
   * @param {MouseEvent} event    The originating left click event
   */
  static async onClickAddDie(event) {
    event.preventDefault();
    const button = event.currentTarget;
    const action = button.dataset.action;
    const sheet = this;

    switch (action) {
      case "add-die": {
        const dice = duplicate(sheet.object.system.skills.dice || []);
        dice.push({ type: "slash", die: "", effect: "" });
        return sheet.object.update({ "system.skills.dice": dice });
      }
      case "remove-die": {
        const index = parseInt(button.dataset.index);
        const dice = duplicate(sheet.object.system.skills.dice || []);
        dice.splice(index, 1);
        return sheet.object.update({ "system.skills.dice": dice });
      }
    }
  }

  /* -------------------------------------------- */


  
  /**
   * Listen for click events and modify attribute groups.
   * @param {MouseEvent} event    The originating left click event
   */
  static async onClickAttributeGroupControl(event) {
    event.preventDefault();
    const a = event.currentTarget;
    const action = a.dataset.action;
    switch ( action ) {
      case "create-group":
        return EntitySheetHelper.createAttributeGroup(event, this);
      case "delete-group":
        return EntitySheetHelper.deleteAttributeGroup(event, this);
    }
  }

  /* -------------------------------------------- */

  /**
   * Listen for the roll button on attributes.
   * @param {MouseEvent} event    The originating left click event
   */
  static onAttributeRoll(event) {
    event.preventDefault();
    const button = event.currentTarget;
    const label = button.closest(".attribute").querySelector(".attribute-label")?.value;
    const chatLabel = label ?? button.parentElement.querySelector(".attribute-key").value;
    const shorthand = game.settings.get("sotc", "macroShorthand");

    // Use the actor for rollData so that formulas are always in reference to the parent actor.
    const rollData = this.actor.getRollData();
    let formula = button.closest(".attribute").querySelector(".attribute-value")?.value;

    // If there's a formula, attempt to roll it.
    if ( formula ) {
      let replacement = null;
      if ( formula.includes('@item.') && this.item ) {
        let itemName = this.item.name.slugify({strict: true}); // Get the machine safe version of the item name.
        replacement = !!shorthand ? `@items.${itemName}.` : `@items.${itemName}.attributes.`;
        formula = formula.replace('@item.', replacement);
      }

      // Create the roll and the corresponding message
      let r = new Roll(formula, rollData);
      return r.toMessage({
        user: game.user.id,
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
        flavor: `${chatLabel}`
      });
    }
  }

  /* -------------------------------------------- */

  /**
   * Return HTML for a new attribute to be applied to the form for submission.
   *
   * @param {Object} items  Keyed object where each item has a "type" and "value" property.
   * @param {string} index  Numeric index or key of the new attribute.
   * @param {string|boolean} group String key of the group, or false.
   *
   * @returns {string} Html string.
   */
  static getAttributeHtml(items, index, group = false) {
    // Initialize the HTML.
    let result = '<div style="display: none;">';
    // Iterate over the supplied keys and build their inputs (including whether they need a group key).
    for (let [key, item] of Object.entries(items)) {
      result = result + `<input type="${item.type}" name="system.attributes${group ? '.' + group : '' }.attr${index}.${key}" value="${item.value}"/>`;
    }
    // Close the HTML and return.
    return result + '</div>';
  }

  /* -------------------------------------------- */

  /**
   * Validate whether or not a group name can be used.
   * @param {string} groupName    The candidate group name to validate
   * @param {Document} document   The Actor or Item instance within which the group is being defined
   * @returns {boolean}
   */
  static validateGroup(groupName, document) {
    let groups = Object.keys(document.system.groups || {});
    let attributes = Object.keys(document.system.attributes).filter(a => !groups.includes(a));

    // Check for duplicate group keys.
    if ( groups.includes(groupName) ) {
      ui.notifications.error(game.i18n.localize("SOTC.NotifyGroupDuplicate") + ` (${groupName})`);
      return false;
    }

    // Check for group keys that match attribute keys.
    if ( attributes.includes(groupName) ) {
      ui.notifications.error(game.i18n.localize("SOTC.NotifyGroupAttrDuplicate") + ` (${groupName})`);
      return false;
    }

    // Check for reserved group names.
    if ( ["attr", "attributes"].includes(groupName) ) {
      ui.notifications.error(game.i18n.format("SOTC.NotifyGroupReserved", {key: groupName}));
      return false;
    }

    // Check for whitespace or periods.
    if ( groupName.match(/[\s|\.]/i) ) {
      ui.notifications.error(game.i18n.localize("SOTC.NotifyGroupAlphanumeric"));
      return false;
    }
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Create new attributes.
   * @param {MouseEvent} event    The originating left click event
   * @param {Object} app          The form application object.
   * @private
   */
  static async createAttribute(event, app) {
    const a = event.currentTarget;
    const group = a.dataset.group;
    let dtype = a.dataset.dtype;
    const attrs = app.object.system.attributes;
    const groups = app.object.system.groups;
    const form = app.form;

    // Determine the new attribute key for ungrouped attributes.
    let objKeys = Object.keys(attrs).filter(k => !Object.keys(groups).includes(k));
    let nk = Object.keys(attrs).length + 1;
    let newValue = `attr${nk}`;
    let newKey = document.createElement("div");
    while ( objKeys.includes(newValue) ) {
      ++nk;
      newValue = `attr${nk}`;
    }

    // Build options for construction HTML inputs.
    let htmlItems = {
      key: {
        type: "text",
        value: newValue
      }
    };

    // Grouped attributes.
    if ( group ) {
      objKeys = attrs[group] ? Object.keys(attrs[group]) : [];
      nk = objKeys.length + 1;
      newValue = `attr${nk}`;
      while ( objKeys.includes(newValue) ) {
        ++nk;
        newValue =  `attr${nk}`;
      }

      // Update the HTML options used to build the new input.
      htmlItems.key.value = newValue;
      htmlItems.group = {
        type: "hidden",
        value: group
      };
      htmlItems.dtype = {
        type: "hidden",
        value: dtype
      };
    }
    // Ungrouped attributes.
    else {
      // Choose a default dtype based on the last attribute, fall back to "String".
      if (!dtype) {
        let lastAttr = document.querySelector('.attributes > .attributes-group .attribute:last-child .attribute-dtype')?.value;
        dtype = lastAttr ? lastAttr : "String";
        htmlItems.dtype = {
          type: "hidden",
          value: dtype
        };
      }
    }

    // Build the form elements used to create the new grouped attribute.
    newKey.innerHTML = EntitySheetHelper.getAttributeHtml(htmlItems, nk, group);

    // Append the form element and submit the form.
    newKey = newKey.children[0];
    form.appendChild(newKey);
    await app._onSubmit(event);
  }

  /**
   * Delete an attribute.
   * @param {MouseEvent} event    The originating left click event
   * @param {Object} app          The form application object.
   * @private
   */
  static async deleteAttribute(event, app) {
    const a = event.currentTarget;
    const li = a.closest(".attribute");
    if ( li ) {
      li.parentElement.removeChild(li);
      await app._onSubmit(event);
    }
  }

  /* -------------------------------------------- */

  /**
   * Create new attribute groups.
   * @param {MouseEvent} event    The originating left click event
   * @param {Object} app          The form application object.
   * @private
   */
  static async createAttributeGroup(event, app) {
    const a = event.currentTarget;
    const form = app.form;
    let newValue = $(a).siblings('.group-prefix').val();
    // Verify the new group key is valid, and use it to create the group.
    if ( newValue.length > 0 && EntitySheetHelper.validateGroup(newValue, app.object) ) {
      let newKey = document.createElement("div");
      newKey.innerHTML = `<input type="text" name="system.groups.${newValue}.key" value="${newValue}"/>`;
      // Append the form element and submit the form.
      newKey = newKey.children[0];
      form.appendChild(newKey);
      await app._onSubmit(event);
    }
  }

  /* -------------------------------------------- */

  /**
   * Delete an attribute group.
   * @param {MouseEvent} event    The originating left click event
   * @param {Object} app          The form application object.
   * @private
   */
  static async deleteAttributeGroup(event, app) {
    const a = event.currentTarget;
    let groupHeader = a.closest(".group-header");
    let groupContainer = groupHeader.closest(".group");
    let group = $(groupHeader).find('.group-key');
    // Create a dialog to confirm group deletion.
    new Dialog({
      title: game.i18n.localize("SOTC.DeleteGroup"),
      content: `${game.i18n.localize("SOTC.DeleteGroupContent")} <strong>${group.val()}</strong>`,
      buttons: {
        confirm: {
          icon: '<i class="fas fa-trash"></i>',
          label: game.i18n.localize("Yes"),
          callback: async () => {
            groupContainer.parentElement.removeChild(groupContainer);
            await app._onSubmit(event);
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: game.i18n.localize("No"),
        }
      }
    }).render(true);
  }

  /* -------------------------------------------- */

  /**
   * Update attributes when updating an actor object.
   * @param {object} formData       The form data object to modify keys and values for.
   * @param {Document} document     The Actor or Item document within which attributes are being updated
   * @returns {object}              The updated formData object.
   */
  static updateAttributes(formData, document) {
    let groupKeys = [];

    // Handle the free-form attributes list
    const formAttrs = foundry.utils.expandObject(formData)?.system?.attributes || {};
    const attributes = Object.values(formAttrs).reduce((obj, v) => {
      let attrs = [];
      let group = null;
      // Handle attribute keys for grouped attributes.
      if ( !v["key"] ) {
        attrs = Object.keys(v);
        attrs.forEach(attrKey => {
          group = v[attrKey]['group'];
          groupKeys.push(group);
          let attr = v[attrKey];
          const k = this.cleanKey(v[attrKey]["key"] ? v[attrKey]["key"].trim() : attrKey.trim());
          delete attr["key"];
          // Add the new attribute if it's grouped, but we need to build the nested structure first.
          if ( !obj[group] ) {
            obj[group] = {};
          }
          obj[group][k] = attr;
        });
      }
      // Handle attribute keys for ungrouped attributes.
      else {
        const k = this.cleanKey(v["key"].trim());
        delete v["key"];
        // Add the new attribute only if it's ungrouped.
        if ( !group ) {
          obj[k] = v;
        }
      }
      return obj;
    }, {});

    // Remove attributes which are no longer used
    for ( let k of Object.keys(document.system.attributes) ) {
      if ( !attributes.hasOwnProperty(k) ) attributes[`-=${k}`] = null;
    }

    // Remove grouped attributes which are no longer used.
    for ( let group of groupKeys) {
      if ( document.system.attributes[group] ) {
        for ( let k of Object.keys(document.system.attributes[group]) ) {
          if ( !attributes[group].hasOwnProperty(k) ) attributes[group][`-=${k}`] = null;
        }
      }
    }

    // Re-combine formData
    formData = Object.entries(formData).filter(e => !e[0].startsWith("system.attributes")).reduce((obj, e) => {
      obj[e[0]] = e[1];
      return obj;
    }, {_id: document.id, "system.attributes": attributes});

    return formData;
  }

  /* -------------------------------------------- */

  /**
   * Update attribute groups when updating an actor object.
   * @param {object} formData       The form data object to modify keys and values for.
   * @param {Document} document     The Actor or Item document within which attributes are being updated
   * @returns {object}              The updated formData object.
   */
  static updateGroups(formData, document) {
    const formGroups = foundry.utils.expandObject(formData).system.groups || {};
    const documentGroups = Object.keys(document.system.groups || {});

    // Identify valid groups submitted on the form
    const groups = Object.entries(formGroups).reduce((obj, [k, v]) => {
      const validGroup = documentGroups.includes(k) || this.validateGroup(k, document);
      if ( validGroup )  obj[k] = v;
      return obj;
    }, {});

    // Remove groups which are no longer used
    for ( let k of Object.keys(document.system.groups)) {
      if ( !groups.hasOwnProperty(k) ) groups[`-=${k}`] = null;
    }

    // Re-combine formData
    formData = Object.entries(formData).filter(e => !e[0].startsWith("system.groups")).reduce((obj, e) => {
      obj[e[0]] = e[1];
      return obj;
    }, {_id: document.id, "system.groups": groups});
    return formData;
  }

  /* -------------------------------------------- */

  /**
   * @see ClientDocumentMixin.createDialog
   */
  static async createDialog(data={}, options={}) {

    // Collect data
    const documentName = this.metadata.name;
    const folders = game.folders.filter(f => (f.type === documentName) && f.displayed);
    const label = game.i18n.localize(this.metadata.label);
    const title = game.i18n.format("DOCUMENT.Create", {type: label});

    // Identify the template Actor types
    const collection = game.collections.get(this.documentName);
    const templates = collection.filter(a => a.getFlag("sotc", "isTemplate"));
    const defaultType = this.TYPES.filter(t => t !== CONST.BASE_DOCUMENT_TYPE)[0] ?? CONST.BASE_DOCUMENT_TYPE;
    const types = {
      [defaultType]: game.i18n.localize("SOTC.NoTemplate")
    }
    for ( let a of templates ) {
      types[a.id] = a.name;
    }

    // Render the document creation form
    const template = "templates/sidebar/document-create.html";
    const html = await renderTemplate(template, {
      name: data.name || game.i18n.format("DOCUMENT.New", {type: label}),
      folder: data.folder,
      folders: folders,
      hasFolders: folders.length > 1,
      type: data.type || templates[0]?.id || "",
      types: types,
      hasTypes: true
    });

    // Render the confirmation dialog window
    return Dialog.prompt({
      title: title,
      content: html,
      label: title,
      callback: html => {

        // Get the form data
        const form = html[0].querySelector("form");
        const fd = new FormDataExtended(form);
        let createData = fd.object;

        // Merge with template data
        const template = collection.get(form.type.value);
        if ( template ) {
          createData = foundry.utils.mergeObject(template.toObject(), createData);
          createData.type = template.type;
          delete createData.flags.sotc.isTemplate;
        }

        // Merge provided override data
        createData = foundry.utils.mergeObject(createData, data, { inplace: false });
        return this.create(createData, {renderSheet: true});
      },
      rejectClose: false,
      options: options
    });
  }

  /* -------------------------------------------- */

  /**
   * Ensure the resource values are within the specified min and max.
   * @param {object} attrs  The Document's attributes.
   */
  static clampResourceValues(attrs) {
    const flat = foundry.utils.flattenObject(attrs);
    for ( const [attr, value] of Object.entries(flat) ) {
      const parts = attr.split(".");
      if ( parts.pop() !== "value" ) continue;
      const current = foundry.utils.getProperty(attrs, parts.join("."));
      if ( current?.dtype !== "Resource" ) continue;
      foundry.utils.setProperty(attrs, attr, Math.clamp(value, current.min || 0, current.max || 0));
    }
  }

  /* -------------------------------------------- */

  /**
   * Clean an attribute key, emitting an error if it contained invalid characters.
   * @param {string} key  The key to clean.
   * @returns {string}
   */
  static cleanKey(key) {
    const clean = key.replace(/[\s.]/g, "");
    if ( clean !== key ) ui.notifications.error("SOTC.NotifyAttrInvalid", { localize: true });
    return clean;
  }
}

/**
 * Enriches a mod/module text string by replacing known status names
 * with inline icon images sourced from matching status items in the world.
 * Also appends a [+] apply button for each matched status.
 *
 * @param {string} text - The raw mod text, e.g. "On Hit: Inflict 2 Sinking"
 * @param {Actor|null} actor - The rolling actor, used to prefer their owned status icons
 * @returns {string} HTML string with inline icons injected
 */
export function enrichModWithStatusIcons(text, actor) {
  const statusMap = new Map();   // name → { img, applyable }

  // World items first (lower priority) — these get a [+] apply button
  game.items.filter(i => i.type === "status").forEach(i => {
    if (i.name) statusMap.set(i.name.toLowerCase(), { img: i.img, applyable: true });
  });

  // Actor's own items override (higher priority — may have custom art)
  if (actor) {
    actor.items.filter(i => i.type === "status").forEach(i => {
      if (i.name) statusMap.set(i.name.toLowerCase(), { img: i.img, applyable: true });
    });
  }

  // Custom keyword icons from settings — display only, no [+] button
  try {
    const customKeywords = JSON.parse(game.settings.get("sotc", "chatKeywords") || "[]");
    for (const kw of customKeywords) {
      if (kw.name && !statusMap.has(kw.name.toLowerCase())) {
        statusMap.set(kw.name.toLowerCase(), { img: kw.img, applyable: false });
      }
    }
  } catch { /* settings not ready yet */ }

  let enriched = text;
  for (const [name, { img, applyable }] of statusMap) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Capture an optional leading number (e.g. "3 Burn" → count=3)
    const regex = new RegExp(`(?<![\\w])(\\d+\\s+)?(${escaped})(?![\\w])`, "gi");
    enriched = enriched.replace(regex, (match, numPart, namePart) => {
      const count = numPart ? numPart.trim() : "";
      const iconHtml = img
        ? `<img src="${img}" alt="${namePart}" title="${namePart}" style="height:1em;width:1em;vertical-align:text-bottom;border:none;display:inline;">`
        : "";
      const applyBtn = applyable
        ? `<a class="apply-status-from-chat" data-status-name="${name}" data-status-count="${count}" title="${game.i18n.format("SOTC.ApplyStatusToTarget", {match: match.trim()})}" style="margin-left:3px;cursor:pointer;color:#c9a227;font-size:11px;font-weight:bold;">[+]</a>`
        : "";
      // Render the number part (if any) before the icon+name
      const numHtml = numPart ? `${numPart}` : "";
      return `${numHtml}${iconHtml}<strong>${namePart}</strong>${applyBtn}`;
    });
  }

  return enriched;
}

/* ─────────────────────────────────────────────────────────────────────────────
   KEYWORD CONFIG — custom icon keywords for chat enrichment
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * A FormApplication that lets the GM manage a list of keyword → icon mappings.
 * These appear inline in chat mod lines (no [+] apply button — display only).
 */
export class KeywordConfigApp extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "sotc-keyword-config",
      title: game.i18n.localize("SOTC.KeywordConfigTitle"),
      template: false,          // We'll render our own HTML
      width: 560,
      height: "auto",
      resizable: true,
      closeOnSubmit: false,
      submitOnChange: false,
    });
  }

  /** Load saved keywords from settings */
  _getKeywords() {
    try {
      return JSON.parse(game.settings.get("sotc", "chatKeywords") || "[]");
    } catch {
      return [];
    }
  }

  /** Build and inject HTML manually since we have no .hbs template file */
  async _renderInner(data) {
    const keywords = this._getKeywords();

    const rows = keywords.map((kw, i) => `
      <li class="kw-row flexrow" data-index="${i}" style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
        <input class="kw-name" type="text" placeholder="${game.i18n.localize("SOTC.KeywordPlaceholder")}" value="${kw.name ?? ""}"
          style="flex:1;"/>
        <input class="kw-img" type="text" placeholder="${game.i18n.localize("SOTC.KeywordImagePlaceholder")}" value="${kw.img ?? ""}"
          style="flex:2;"/>
        ${kw.img ? `<img src="${kw.img}" style="height:24px;width:24px;border:none;flex-shrink:0;" onerror="this.style.display='none'">` : `<span style="width:24px;"></span>`}
        <a class="kw-browse" data-index="${i}" title="${game.i18n.localize("SOTC.KeywordBrowse")}" style="cursor:pointer;flex-shrink:0;">
          <i class="fas fa-folder-open"></i>
        </a>
        <a class="kw-delete" data-index="${i}" title="${game.i18n.localize("SOTC.KeywordRemove")}" style="cursor:pointer;flex-shrink:0;">
          <i class="fas fa-trash"></i>
        </a>
      </li>
    `).join("");

    const html = `
      <div style="padding:8px;">
        <p style="font-size:12px;margin-bottom:8px;color:#555;">
          ${game.i18n.localize("SOTC.KeywordConfigHelp")}
        </p>
        <ul id="kw-list" style="list-style:none;padding:0;margin:0;">
          ${rows}
        </ul>
        <div style="margin-top:8px;">
          <button type="button" id="kw-add" style="width:100%;">
            <i class="fas fa-plus"></i> ${game.i18n.localize("SOTC.KeywordAdd")}
          </button>
        </div>
        <div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end;">
          <button type="button" id="kw-save" style="min-width:80px;">
            <i class="fas fa-save"></i> ${game.i18n.localize("SOTC.ButtonSave")}
          </button>
          <button type="button" id="kw-close" style="min-width:80px;">
            ${game.i18n.localize("SOTC.ButtonCancel")}
          </button>
        </div>
      </div>
    `;

    // Return a jQuery element wrapping our HTML
    return $(html);
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Add new row
    html.find("#kw-add").on("click", () => {
      const keywords = this._getKeywords();
      keywords.push({ name: "", img: "" });
      game.settings.set("sotc", "chatKeywords", JSON.stringify(keywords)).then(() => this.render());
    });

    // Delete a row
    html.find(".kw-delete").on("click", ev => {
      const i = Number(ev.currentTarget.dataset.index);
      const keywords = this._getKeywords();
      keywords.splice(i, 1);
      game.settings.set("sotc", "chatKeywords", JSON.stringify(keywords)).then(() => this.render());
    });

    // Browse for image using Foundry's FilePicker
    html.find(".kw-browse").on("click", ev => {
      const i = Number(ev.currentTarget.dataset.index);
      const picker = new FilePicker({
        type: "image",
        current: html.find(`.kw-row[data-index="${i}"] .kw-img`).val() || "systems/sotc/assets/",
        callback: path => {
          html.find(`.kw-row[data-index="${i}"] .kw-img`).val(path);
          // Update preview
          const row = html.find(`.kw-row[data-index="${i}"]`);
          let preview = row.find("img");
          if (!preview.length) {
            preview = $(`<img style="height:24px;width:24px;border:none;flex-shrink:0;">`);
            row.find(".kw-browse").before(preview);
          }
          preview.attr("src", path).show();
        }
      });
      picker.browse();
    });

    // Live preview when img path is typed
    html.find(".kw-img").on("input", ev => {
      const row = $(ev.currentTarget).closest(".kw-row");
      const path = ev.currentTarget.value;
      let preview = row.find("img");
      if (!preview.length) {
        preview = $(`<img style="height:24px;width:24px;border:none;flex-shrink:0;">`);
        row.find(".kw-browse").before(preview);
      }
      preview.attr("src", path).show();
    });

    // Save
    html.find("#kw-save").on("click", () => this._saveAndClose(html));

    // Cancel
    html.find("#kw-close").on("click", () => this.close());
  }

  async _saveAndClose(html) {
    const rows = html.find(".kw-row");
    const keywords = [];
    rows.each((_, row) => {
      const name = $(row).find(".kw-name").val().trim();
      const img  = $(row).find(".kw-img").val().trim();
      if (name) keywords.push({ name, img });
    });
    await game.settings.set("sotc", "chatKeywords", JSON.stringify(keywords));
    ui.notifications.info(game.i18n.localize("SOTC.NotifyKeywordsSaved"));
    this.close();
  }

  // Required stub
  async _updateObject() {}
}
