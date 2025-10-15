import { EntitySheetHelper } from "./helper.js";
import {ATTRIBUTE_TYPES} from "./constants.js";

/**
 * Extend the basic ItemSheet with some very simple modifications
 * @extends {ItemSheet}
 */
export class SotCStatusSheet extends ItemSheet {

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
    if (context.data.img === "icons/svg/item-bag.svg") {
      context.data.img = "systems/sotc/assets/statuses/Default.png";
    }
    EntitySheetHelper.getAttributeData(context.data);
    context.systemData = context.data.system;
    context.sheetEditMode = this.item.getFlag("sotc", "sheetEditMode") || false;
    context.dtypes = ATTRIBUTE_TYPES;
    context.descriptionHTML = await TextEditor.enrichHTML(context.systemData.description, {
      secrets: this.document.isOwner,
      async: true
    });
    return context;
  }

  /* -------------------------------------------- */

  /** @inheritdoc */
  activateListeners(html) {
    super.activateListeners(html);
    html.find(".post_actives-control").click(this._onActivesControl.bind(this));

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
    const first_letter = type.charAt(0)
    const remaining_letters = type.substring(1)
    type = first_letter.toUpperCase() + remaining_letters
    const condition = s.condition || "";
    const potencyFlat = s.potency_flat ?? 0;
    const potency = s.potency ?? 0;
    const effect = s.effect || "";
    let target = s.target || "";
    if (target === "hp") {
      target = "HP"
    }
    const special = s.special?.trim();

    let message = "";
    let flat_message = ``
    if (potencyFlat) {
      flat_message = `by <b>${potencyFlat}</b> flat, and`
    }

    switch (condition) {
      case "passive":
        message = `
          <div class="status-chat">
            <h2>${icon}${name}</h2>
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
            <h2>${icon}${name}</h2>
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
            <h2>${icon}${name}</h2>
            <p><b>Type:</b> ${type}</p>
            <b>Description:</b>
            ${special ? `<p>${special}</p>` : "<p><i>Missing Description.</i></p>"}
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

    // Post to chat
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

    // Add new post active control button option thing <- words uttered by the deranged
    if ( a.classList.contains("add-option") ) {
      await this._onSubmit(event);
      const updated_post_array = [...post_actives_array, { operator: "maintain", variable: 0 }];
      return this.item.update({ "system.post_actives": updated_post_array });
    }

    // Remove a post active control button option thing
    if ( a.classList.contains("remove-option") ) {
      await this._onSubmit(event);
      const li = a.closest(".post_effect_contents");
      const index = Number(li.dataset.postActive);
      const updated_post_array = foundry.utils.deepClone(post_actives_array);
      updated_post_array.splice(index, 1);
      return this.item.update({ "system.post_actives": updated_post_array });
    }
  }
}