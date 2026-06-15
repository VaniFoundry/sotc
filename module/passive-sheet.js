import { EntitySheetHelper, enrichModWithStatusIcons } from "./helper.js";
import {ATTRIBUTE_TYPES} from "./constants.js";

/**
 * Extend the basic ItemSheet with some very simple modifications
 * @extends {ItemSheet}
 */
export class SotCPassiveSheet extends foundry.appv1.sheets.ItemSheet {

  /** @inheritdoc */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["sotc", "sheet", "item", "passive", "biography"],
      template: "systems/sotc/templates/passive-sheet.html",
      width: 656,
      height: 320
    });
  }

  /* -------------------------------------------- */

  /** @inheritdoc */
  async getData(options) {
    const context = await super.getData(options);
    EntitySheetHelper.getAttributeData(context.data);
    context.systemData = context.data.system;
    context.sheetEditMode = this.item.getFlag("sotc", "sheetEditMode") || false;
    context.dtypes = ATTRIBUTE_TYPES;
    // Again, not sure if I even need this but I don't want to test removing it. The commenting is easier than the removing it
    // Haha! I have figured it out. I need some stuff added for v11-12, or rather to make my v11-12 stuff work with v13. Is this why pathfinder is still stuck on v11? Lazy buggers.
    const fv = game.version ?? game?.data?.version;
    const use_v13 = foundry.utils.isNewerVersion(fv, "12.999");
    if (use_v13) {
      context.detailsHTML = enrichModWithStatusIcons(context.systemData.details ?? "", this.actor);
    } else {
      const enriched = await TextEditor.enrichHTML(context.systemData.details ?? "", {
        secrets: this.document.isOwner,
        async: true
      });
      context.detailsHTML = enrichModWithStatusIcons(enriched, this.actor);
    }
    return context;
  }

  /* -------------------------------------------- */

  /** @inheritdoc */
  activateListeners(html) {
    super.activateListeners(html);

    html.find(".print-passive_card").click(ev => {
      ev.preventDefault();
      this._printPassive(this.item);
    });
  }

  async _printPassive(item) {
    const name = item.name;
    const rawDetails = item.system.details ?? "";
    // Enrich details with status icons so keywords like "Burn", "Bleed" show inline icons
    const actor = item.actor ?? game.actors.find(a => a.items.has(item.id));
    const details = enrichModWithStatusIcons(rawDetails, actor);

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

  /** @override */
  _getSubmitData(updateData) {
    let formData = super._getSubmitData(updateData);
    formData = EntitySheetHelper.updateAttributes(formData, this.object);
    formData = EntitySheetHelper.updateGroups(formData, this.object);
    return formData;
  }
  
}