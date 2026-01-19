/**
 * Create a Macro from an attribute drop.
 * Get an existing sotc macro if one exists, otherwise create a new one.
 * @param {Object} data     The dropped data
 * @param {number} slot     The hotbar slot to use
 * @returns {Promise}
 */
export async function createSotCMacro(data, slot) {
  if ( !data.roll || !data.label ) return false;
  const command = `const roll = new Roll("${data.roll}", actor ? actor.getRollData() : {});
  roll.toMessage({speaker, flavor: "${data.label}"});`;
  let macro = game.macros.find(m => (m.name === data.label) && (m.command === command));
  if (!macro) {
    macro = await Macro.create({
      name: data.label,
      type: "script",
      command: command,
      flags: { "sotc.attrMacro": true }
    });
  }
  game.user.assignHotbarMacro(macro, slot);
  return false;
}

export class SOTCHotbar {

  static async createSkillMacro(item, slot) {

    const command = `
const token = canvas.tokens.controlled[0];
if (!token) {
  ui.notifications.warn("Please select a token to roll this skill.");
  return;
}

const actor = token.actor;
const item = actor.items.get("${item.id}");
if (!item) {
  ui.notifications.error("Selected actor does not have this skill.");
  return;
}

// Fabricate a fake click event for your existing handler
const sheet = actor.sheet;
if (!sheet || !sheet._onRollFullSkill) {
  ui.notifications.error("Actor sheet is not ready.");
  return;
}

sheet._onRollFullSkill({
  currentTarget: {
    dataset: { itemId: item.id }
  }
});
`;

    const macro = await Macro.create({
      name: item.name,
      type: "script",
      img: item.img,
      command
    });

    await game.user.assignHotbarMacro(macro, slot);
  }
}