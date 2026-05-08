import { EntitySheetHelper } from "./helper.js";
import {ATTRIBUTE_TYPES} from "./constants.js";

/**
 * Extend the basic ItemSheet with some very simple modifications
 * @extends {ItemSheet}
 */
export class SotCStatusSheet extends foundry.appv1.sheets.ItemSheet {

  /** @inheritdoc */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["sotc", "sheet", "item", "status"],
      template: "systems/sotc/templates/status-sheet.html",
      width: 656,
      height: 320
    });
  }

  /* -------------------------------------------- */

  /** @inheritdoc */
  async getData(options) {
    const context = await super.getData(options);

    // Foundry v13: ItemSheet.getData() no longer guarantees context.data exists.
    // Fall back to this.item for img and system data.
    const itemData = context.data ?? this.item;
    if (itemData.img === "icons/svg/item-bag.svg") {
      itemData.img = "systems/sotc/assets/statuses/Default.png";
    }

    // Status items have no system.attributes — do NOT call EntitySheetHelper.getAttributeData()
    // here, it throws "Cannot read properties of undefined (reading 'attributes')" and
    // silently aborts getData(), preventing the sheet from opening.

    context.systemData = itemData.system ?? this.item.system ?? {};
    context.sheetEditMode = this.item.getFlag("sotc", "sheetEditMode") || false;
    context.dtypes = ATTRIBUTE_TYPES;
    try {
      context.descriptionHTML = await TextEditor.enrichHTML(context.systemData.description ?? "", {
        secrets: this.document.isOwner,
        async: true
      });
    } catch (e) {
      context.descriptionHTML = context.systemData.description ?? "";
    }

    // Ensure min_resource_limit is always present on every trigger entry so the
    // template can render an input for it without undefined-related issues.
    // The default is 0 for all statuses; Sinking gets 1 applied at actor-creation
    // time (see the createActor hook in sotc.js).
    const normaliseMinLimit = (raw) => {
      const arr = Array.isArray(raw) ? raw : Object.values(raw ?? {});
      return arr.map(entry => ({
        min_resource_limit: 0,
        ...entry
      }));
    };

    context.post_actives_normalised = normaliseMinLimit(context.systemData.post_actives);
    context.scene_end_effect_normalised = {
      ...context.systemData.scene_end_effect,
      min_resource_limit: context.systemData.scene_end_effect?.min_resource_limit ?? 0
    };

    return context;
  }

  /* -------------------------------------------- */

  /** @inheritdoc */
  activateListeners(html) {
    super.activateListeners(html);
    // Foundry v13 passes a raw HTMLElement instead of jQuery; wrap so .find() works.
    html = $(html);
    html.find(".post_actives-control").click(this._onActivesControl.bind(this));
    html.find(".stagger_effects-control").click(this._onStaggerControl.bind(this));
    html.find(".print-status_card").click(this._printStatus.bind(this));
  }

  async _printStatus(event) {
    event.preventDefault();
    const status = this.item;

    if (!status) return ui.notifications.error("No status data found.");

    const s = status.system;
    const name = status.name;
    const icon = status.img ? `<img src="${status.img}" width="auto" height="32px" style="vertical-align: middle; margin-right: 4px; border: none;">` : "";
    let type = s.types || "other";
    const first_letter = type.charAt(0);
    const remaining_letters = type.substring(1);
    type = first_letter.toUpperCase() + remaining_letters;
    const condition = s.condition || "";
    const potencyFlat = s.potency_flat ?? 0;
    const potency = s.potency ?? 0;
    const effect = s.effect || "";
    let target = s.target || "";
    if (target === "hp") target = "HP";
    const special = s.special?.trim();

    let message = "";
    let flat_message = "";
    if (potencyFlat) {
      flat_message = `by <b>${potencyFlat}</b> flat, and`;
    }

    switch (condition) {
      case "passive":
        message = `
          <div class="status-chat">
            <h3><div style="display: flex;">${icon}<span style="margin-top:4px;">${name}</span></div></h3>
            <p><b>Type:</b> ${type}</p>
            <b>Description:</b>
            <p>Passively ${effect} ${target} ${flat_message} by <b>${potency}</b> per count.</p>
            ${special ? `<p>${special}</p>` : ""}
          </div>
        `;
        break;

      case "active":
        message = `
          <div class="status-chat">
            <h3><div style="display: flex;">${icon}<span style="margin-top:4px;">${name}</span></div></h3>
            <p><b>Type:</b> ${type}</p>
            <b>Description:</b>
            <p>On Trigger ${effect} ${target} ${flat_message} by <b>${potency}</b> per count.</p>
            ${special ? `<p>${special}</p>` : ""}
          </div>
        `;
        break;

      case "special":
        message = `
          <div class="status-chat">
            <h3><div style="display: flex;">${icon}<span style="margin-top:4px;">${name}</span></div></h3>
            <p><b>Type:</b> ${type}</p>
            <b>Description:</b>
            ${special ? `<p>${special}</p>` : "<p><i>Missing Description.</i></p>"}
          </div>
        `;
        break;

      case "stagger_like":
        message = `
          <div class="status-chat">
            <h3><div style="display: flex;">${icon}<span style="margin-top:4px;">${name}</span></div></h3>
            <p><b>Type:</b> ${type}</p>
            <b>Description:</b>
            <p><i>Stagger-like effects don't have description support yet.</i></p>
          </div>
        `;
        break;

      default:
        message = `
          <div class="status-chat">
            <h3>${icon}${name} <small>(${type})</small></h3>
            <p><i>Missing Effect Details.</i></p>
          </div>
        `;
        break;
    }

    ChatMessage.create({
      user: game.user.id,
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content: message,
    });
  }

  async _onActivesControl(event) {
    event.preventDefault();
    const a = event.currentTarget;
    const raw_post_actives = this.item.system.post_actives;
    const post_actives_array = Array.isArray(raw_post_actives) ? raw_post_actives : Object.values(raw_post_actives);

    if (a.classList.contains("add-option")) {
      await this._onSubmit(event);
      const updated_post_array = [...post_actives_array, { operator: "maintain", variable: 0, min_resource_limit: 0 }];
      return this.item.update({ "system.post_actives": updated_post_array });
    }

    if (a.classList.contains("remove-option")) {
      await this._onSubmit(event);
      const li = a.closest(".post_effect_contents");
      const index = Number(li.dataset.postActive);
      const updated_post_array = foundry.utils.deepClone(post_actives_array);
      updated_post_array.splice(index, 1);
      return this.item.update({ "system.post_actives": updated_post_array });
    }
  }

  async _onStaggerControl(event) {
    event.preventDefault();
    const a = event.currentTarget;
    const raw_stagger_effects = this.item.system.stagger_effects;
    const stagger_effects_array = Array.isArray(raw_stagger_effects) ? raw_stagger_effects : Object.values(raw_stagger_effects);

    if (a.classList.contains("add-option")) {
      await this._onSubmit(event);
      const updated_post_array = [...stagger_effects_array, { operator: "maintain", variable: 0, min_resource_limit: 0 }];
      return this.item.update({ "system.stagger_effects": updated_post_array });
    }

    if (a.classList.contains("remove-option")) {
      await this._onSubmit(event);
      const li = a.closest(".stagger_effect_contents");
      const index = Number(li.dataset.postActive);
      const updated_post_array = foundry.utils.deepClone(stagger_effects_array);
      updated_post_array.splice(index, 1);
      return this.item.update({ "system.stagger_effects": updated_post_array });
    }
  }
}
