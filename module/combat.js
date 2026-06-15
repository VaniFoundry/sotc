/**
 * combat.js — SotC Combat Lifecycle
 *
 * Covers:
 *  - SotCCombat class (rollInitiative, rollAll, grouped initiative chat card)
 *  - Combat tracker hooks (renderCombatTracker, createCombatant, deleteCombatant,
 *    preRollInitiative, combatRound, deleteCombat)
 *  - Status-effect sync machinery (syncStatusItemEffect, spawnSpeedDiceClones,
 *    drawCountBadges, TokenHUD override, renderTokenHUD)
 *  - Item lifecycle hooks (createItem, updateItem, deleteItem, preUpdateItem)
 *  - Token hooks (createToken, canvasReady)
 *  - Safeguard notification logic
 *
 * Exported so sotc.js can wire CONFIG.Combat.documentClass and game.sotc.
 */

// ── applyOperator ─────────────────────────────────────────────────────────────
// Shared helper used by combatRound status tick logic.
export function applyOperator(value, operator, variable = 0) {
  switch (operator) {
    case "maintain": return value;
    case "clear":    return 0;
    case "add":      return value + variable;
    case "subtract": return Math.max(value - variable, 0);
    case "multiply": return value * variable;
    case "divide":   return Math.floor(value / Math.max(variable, 1));
    default:         return value;
  }
}

// ── SOTC_BASE_EFFECTS ─────────────────────────────────────────────────────────
// The Foundry built-in status effects we leave alone (handled by core, not us).
export const SOTC_BASE_EFFECTS = new Set(["dead", "prone", "unconscious", "sleep"]);

// ── getActorStatusEffect ──────────────────────────────────────────────────────
export function getActorStatusEffect(actor, statusId) {
  return actor?.effects?.find(e =>
    e.flags?.sotc?.statusItemId === statusId ||
    e.statuses?.has(statusId)
  ) ?? null;
}

// ── SotCCombat ────────────────────────────────────────────────────────────────
export class SotCCombat extends Combat {

  async rollInitiative(ids, { formula = null, updateTurn = true, messageOptions = {} } = {}) {
    ids = typeof ids === "string" ? [ids] : ids;
    const combatants = this.combatants.filter(c => ids.includes(c.id));
    const updates = [];

    function computeSpeedModFromStatuses(actor, baseFormula) {
      if (!actor) return 0;
      let speed_mod = 0;

      const statuses = actor.items.filter(i =>
        i.type === "status" &&
        i.system?.condition === "passive" &&
        Number(i.system?.count) > 0
      );
      for (const status of statuses) {
        if (["haste", "bind"].includes(status.name.toLowerCase())) continue;
        const { effect, target, potency_flat = 0, potency = 0, count = 0 } = status.system;
        if (!target) continue;
        const sign  = effect === "Increase" ? 1 : -1;
        const bonus = (Number(potency_flat || 0) + Number(potency || 0) * Number(count || 0)) * sign;
        if (target === "speed") speed_mod += bonus;
      }

      const hasteStatus = actor.items.find(i =>
        i.type === "status" && i.name.toLowerCase() === "haste" && Number(i.system?.count) > 0
      );
      const bindStatus  = actor.items.find(i =>
        i.type === "status" && i.name.toLowerCase() === "bind" && Number(i.system?.count) > 0
      );
      const hasteCount = hasteStatus ? Number(hasteStatus.system.count) : 0;
      const bindCount  = bindStatus  ? Number(bindStatus.system.count)  : 0;

      if (hasteCount || bindCount) {
        const baseMin = (() => {
          const m = (baseFormula ?? "1d6").match(/^(\d+)d(\d+)/i);
          return m ? Number(m[1]) : 1;
        })();
        const net     = hasteCount - bindCount;
        const clamped = Math.max(1 - baseMin, net);
        speed_mod    += clamped;
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
      let total_formula   = `${actor_formula}`;

      const status_speed_mod = computeSpeedModFromStatuses(actor, actor_formula);
      const stored_speed_mod = actor?.system?.modifiers.speed_mod ?? 0;
      const init_mod         = status_speed_mod || stored_speed_mod || 0;
      const actor_type       = actor?.system?.initiative_type;

      if (init_mod > 0)       total_formula = `${total_formula}+${init_mod}`;
      else if (init_mod < 0)  total_formula = `${total_formula}-${-init_mod}`;

      const final_formula = (total_formula && Roll.validate(total_formula))
        ? total_formula
        : formula || CONFIG.Combat.initiative.formula;

      const roll        = await (new Roll(final_formula).evaluate({ async: true }));
      let   final_init  = Math.max(1, roll.total);
      if (actor_type === "player") final_init = final_init + 0.01;

      updates.push({ _id: c.id, initiative: final_init });

      // Clear Haste and Bind after applying their bonus
      const hasteToClear = actor.items.find(i =>
        i.type === "status" && i.name.toLowerCase() === "haste" && Number(i.system?.count) > 0
      );
      const bindToClear  = actor.items.find(i =>
        i.type === "status" && i.name.toLowerCase() === "bind" && Number(i.system?.count) > 0
      );
      const clearUpdates = [];
      if (hasteToClear) clearUpdates.push({ _id: hasteToClear.id, "system.count": 0 });
      if (bindToClear)  clearUpdates.push({ _id: bindToClear.id,  "system.count": 0 });
      if (clearUpdates.length) await actor.updateEmbeddedDocuments("Item", clearUpdates);

      if (this._sotcGroupInitiative) {
        this._sotcGroupInitiative.push({
          name:    c.name,
          img:     c.actor?.img ?? "icons/svg/mystery-man.svg",
          formula: final_formula,
          rolled:  roll.total - init_mod,
          mod:     init_mod,
          final:   final_init,
          type:    actor_type
        });
      } else {
        await roll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor: c.actor }),
          flavor:  `${c.name} rolls initiative (${roll.total - init_mod} → ${final_init})`,
          sound:   CONFIG.sounds.dice ?? null,
        }, messageOptions);
      }
    }

    await this.updateEmbeddedDocuments("Combatant", updates);
    if (updateTurn) this.update({ turn: this.turns.findIndex(t => t.initiative !== null) });
    return this;
  }

  async rollAll(options = {}) {
    const ids = this.combatants
      .filter(c => c.initiative === null)
      .map(c => c.id);
    if (!ids.length) return this;

    this._sotcGroupInitiative = [];

    const originalSound     = CONFIG.sounds.dice;
    CONFIG.sounds.dice      = null;
    try {
      await this.rollInitiative(ids, options);
    } finally {
      CONFIG.sounds.dice = originalSound;
    }

    if (originalSound) {
      foundry.audio.AudioHelper.play(
        { src: originalSound, volume: 0.8, autoplay: true, loop: false }, true
      );
    }

    const initRows = this._sotcGroupInitiative ?? [];
    delete this._sotcGroupInitiative;

    if (initRows.length) {
      const round      = this.round ?? 1;
      const playerRows = initRows.filter(r => r.type === "player").sort((a, b) => b.final - a.final);
      const enemyRows  = initRows.filter(r => r.type !== "player").sort((a, b) => b.final - a.final);
      const allRows    = [...playerRows, ...enemyRows];

      const typeColor = r  => r.type === "player" ? "#4caf7d" : "#e05050";
      const modStr    = r  => r.mod > 0 ? `+${r.mod}` : r.mod < 0 ? `${r.mod}` : "";

      const rowsHtml = allRows.map(r => `
        <div style="display:flex; align-items:center; gap:8px; padding:3px 0; border-top:1px solid #1e1c2a;">
          <img src="${r.img}" style="width:22px; height:22px; border-radius:50%; object-fit:cover; border:1px solid #3a3050; flex-shrink:0;">
          <span style="flex:1; font-size:12px; color:#ddd;">${r.name}</span>
          <span style="font-size:11px; color:#888;">${r.formula}${modStr(r) ? ` ${modStr(r)}` : ""} = ${r.rolled}</span>
          <span style="font-size:12px; font-weight:700; color:${typeColor(r)}; min-width:24px; text-align:right;">${Math.floor(r.final)}</span>
        </div>`).join("");

      const topResult  = allRows[0];
      const previewText = topResult
        ? `<span style="font-size:11px; color:#aaa;">${topResult.name} <strong style="color:#c9a227;">${Math.floor(topResult.final)}</strong> &nbsp;· ${initRows.length} rolled</span>`
        : `<span style="font-size:11px; color:#aaa;">${initRows.length} rolled</span>`;

      const cardHtml = `
        <div style="background:#12111a; border:1px solid #3a3050; border-radius:6px; padding:10px 12px; font-family:'Signika',sans-serif; line-height:1.6;">
          <div class="sotc-init-toggle" style="display:flex; justify-content:space-between; align-items:center; cursor:pointer; user-select:none; margin-bottom:4px;">
            <div style="display:flex; align-items:center; gap:6px;">
              <i class="fas fa-chevron-down sotc-init-chevron" style="font-size:10px; color:#888; transition:transform 0.15s;"></i>
              <strong style="color:#e8d9a0; font-size:14px;">Initiative — Round ${round}</strong>
            </div>
            ${previewText}
          </div>
          <div class="sotc-init-rows" data-collapsed="false">${rowsHtml}</div>
        </div>`;

      await ChatMessage.create({
        speaker: { alias: "Combat" },
        content: cardHtml,
        flags:   { sotc: { initiativeGroup: true } }
      });
    }

    return this;
  }
}

// ── spawnSpeedDiceClones ──────────────────────────────────────────────────────
async function spawnSpeedDiceClones(item, newCount) {
  if (item.system?.condition !== "passive") return;
  if (item.system?.target    !== "number of speed dice") return;
  if (!game.combat?.active) return;
  if (newCount <= 0) return;

  const actor = item.actor;
  if (!actor) return;

  const OWNER_LEVEL = 3;
  const designatedOwner = game.users.find(u =>
    !u.isGM && u.active &&
    (actor.ownership[u.id] === OWNER_LEVEL || actor.ownership.default === OWNER_LEVEL)
  );
  if (designatedOwner) {
    if (game.user.id !== designatedOwner.id) return;
  } else {
    if (!game.user.isGM || !game.users.activeGM?.isSelf) return;
  }

  const sign     = item.system.effect === "Decrease" ? -1 : 1;
  const flat     = Number(item.system.potency_flat ?? 0);
  const pot      = Number(item.system.potency ?? 0);
  const extra    = (flat + pot * newCount) * sign;
  const base     = Number(actor.system.speed_dice?.num_dice ?? 1);
  const expected = base + extra;
  const existing = game.combat.combatants.filter(c => c.actorId === actor.id);
  const toCreate = Math.max(0, expected - existing.length);

  if (toCreate <= 0) return;

  const base_combatant  = existing.find(c => !c.flags?.sotc?.isSpeedDieClone);
  if (!base_combatant) return;

  const actorFormula = actor.system?.speed_dice?.dice_size ?? CONFIG.Combat.initiative.formula ?? "1d6";

  for (let i = 0; i < toCreate; i++) {
    const cloneIndex = existing.length + i;
    let initiative   = null;
    try {
      const roll = await new Roll(actorFormula).evaluate({ async: true });
      initiative  = Math.max(1, roll.total);
    } catch (err) {
      console.warn(`sotc | spawnSpeedDiceClones: could not roll initiative for clone:`, err);
    }
    await game.combat.createEmbeddedDocuments("Combatant", [{
      actorId:    actor.id,
      tokenId:    base_combatant.tokenId,
      hidden:     false,
      initiative,
      name:       `${base_combatant.name} #${cloneIndex + 1}`,
      flags:      { sotc: { isSpeedDieClone: true, speedDieIndex: cloneIndex } }
    }]);
    ui.combat?.render();
  }
}

// ── syncStatusItemEffect ──────────────────────────────────────────────────────
const _syncLocks = new Set();

async function syncStatusItemEffect(item) {
  if (item.type !== "status") return;
  const actor = item.actor;
  if (!actor) return;

  const OWNER_LEVEL = 3;
  const designatedOwner = game.users.find(u =>
    !u.isGM && u.active &&
    (actor.ownership[u.id] === OWNER_LEVEL || actor.ownership.default === OWNER_LEVEL)
  );

  if (designatedOwner) {
    if (game.user.id !== designatedOwner.id) return;
  } else {
    const isActiveGM = game.user.isGM && game.users.activeGM?.isSelf;
    if (!isActiveGM) return;
  }

  const lockKey = `${actor.id}::${item.id}`;
  if (_syncLocks.has(lockKey)) return;
  _syncLocks.add(lockKey);

  try {
    const count       = Number(item.system?.count ?? 0);
    const allMatching = actor.effects.filter(e =>
      e.flags?.sotc?.statusItemId === item.id || e.statuses?.has(item.id)
    );

    // Deduplicate — keep at most one
    if (allMatching.length > 1) {
      const dupeIds = allMatching.slice(1).map(e => e.id).filter(id => actor.effects.has(id));
      if (dupeIds.length) {
        try {
          await actor.deleteEmbeddedDocuments("ActiveEffect", dupeIds);
        } catch (err) {
          console.warn(`sotc | syncStatusItemEffect: could not delete dupes for ${item.name}:`, err.message);
        }
      }
    }

    const existing = allMatching[0] ?? null;

    if (count > 0 && !existing) {
      await actor.createEmbeddedDocuments("ActiveEffect", [{
        name:     item.name,
        icon:     item.img,
        statuses: [item.id],
        origin:   item.uuid,
        transfer: false,
        flags:    { sotc: { statusItemId: item.id } }
      }]);
      canvas.tokens?.placeables
        .filter(t => t.actor?.id === actor.id)
        .forEach(t => requestAnimationFrame(() => t.drawEffects()));
      return;
    }

    if (count <= 0 && existing) {
      if (actor.effects.has(existing.id)) {
        try {
          await existing.delete();
        } catch (err) {
          console.warn(`sotc | syncStatusItemEffect: could not delete effect for ${item.name}:`, err.message);
        }
      }
    }
  } finally {
    _syncLocks.delete(lockKey);
  }
}

// ── drawCountBadges ───────────────────────────────────────────────────────────
function drawCountBadges(token) {
  const actor = token.actor;
  if (!actor || !token.effects) return;

  const sprites = token.effects.children.filter(c => c.isSprite);
  if (!sprites.length) return;

  for (const effect of actor.effects) {
    const statusId = effect.flags?.sotc?.statusItemId;
    if (!statusId) continue;

    const item = actor.items.get(statusId);
    if (!item || item.type !== "status") continue;
    if (item.system.condition === "stagger_like") continue;

    const count = Number(item.system.count ?? 0);
    if (count <= 0) continue;

    const sprite = sprites.find(s => {
      const src = s.texture?.baseTexture?.resource?.src;
      return src && src.includes((effect.img ?? effect.icon ?? "").split("/").pop());
    });
    if (!sprite) continue;

    for (const child of [...sprite.children]) {
      if (child.name === "sotc-count") sprite.removeChild(child);
    }

    const bounds = sprite.getLocalBounds();
    const badge  = new PIXI.Text(String(count), {
      fontSize:        Math.floor(bounds.width * 0.4),
      fill:            0xffffff,
      stroke:          0x000000,
      strokeThickness: 4,
      fontWeight:      "900"
    });
    badge.name = "sotc-count";
    badge.anchor.set(1, 1);
    badge.position.set(bounds.width, bounds.height);
    sprite.addChild(badge);
  }
}

// ── _notifySafeguard ──────────────────────────────────────────────────────────
async function _notifySafeguard(actor, item, newCount, stacksDelta) {
  if (!game.user.isGM || !game.users.activeGM?.isSelf) return;

  const safeguard = actor.items.find(i =>
    i.type === "status" &&
    i.name.toLowerCase() === "safeguard" &&
    Number(i.system?.count ?? 0) > 0
  );
  if (!safeguard) return;

  // stacksDelta = how many stacks were just added (what Safeguard will remove).
  // Falls back to newCount in case of legacy callers (e.g. createItem with prevCount=0).
  stacksDelta = stacksDelta ?? newCount;

  const sgCount    = Number(safeguard.system.count);
  const statusType = item.system?.types ?? "status";
  const OWNER_LEVEL = 3;

  const whisperTo = game.users.filter(u =>
    u.active && (
      u.isGM ||
      actor.ownership[u.id] === OWNER_LEVEL ||
      actor.ownership.default === OWNER_LEVEL
    )
  );

  const sgIcon     = `<img src="systems/sotc/assets/statuses/Safeguard.png" style="width:20px;height:20px;border:none;vertical-align:middle;margin-right:5px;">`;
  const statusIcon = item.img ? `<img src="${item.img}" style="width:16px;height:16px;border:none;vertical-align:middle;margin-right:4px;">` : "";

  await ChatMessage.create({
    content: `
      <div style="font-family:'Signika',sans-serif;background:#12111a;border:1px solid #2a5040;border-radius:6px;padding:10px 12px;">
        <div style="color:#4caf7d;font-weight:700;font-size:13px;margin-bottom:8px;">${sgIcon}Safeguard — ${actor.name}</div>
        <div style="color:#ccc;font-size:12px;margin-bottom:10px;">
          ${statusIcon}<b style="color:#e8d9a0;">${item.name}</b> (${statusType}) +${stacksDelta} applied (now ${newCount}).
          <br>Spend 1 Safeguard (${sgCount} → ${sgCount - 1}) to nullify those ${stacksDelta} stack${stacksDelta > 1 ? 's' : ''}?
        </div>
        <div style="display:flex;gap:8px;">
          <button class="sotc-safeguard-yes"
            data-actor-id="${actor.id}"
            data-safeguard-id="${safeguard.id}"
            data-sg-count="${sgCount}"
            data-status-id="${item.id}"
            data-status-delta="${stacksDelta}"
            style="flex:1;background:#2a5040;color:#aee8c8;border:1px solid #3a7060;border-radius:4px;padding:4px 8px;cursor:pointer;">
            <i class="fas fa-shield-alt"></i> Spend Safeguard
          </button>
          <button class="sotc-safeguard-no"
            style="flex:1;background:#3a2020;color:#e8a0a0;border:1px solid #6a3030;border-radius:4px;padding:4px 8px;cursor:pointer;">
            <i class="fas fa-times"></i> Ignore
          </button>
        </div>
      </div>`,
    whisper: whisperTo,
    speaker: { alias: actor.name },
    flags:   { sotc: { safeguardPromptActorId: actor.id } }
  });
}

// Track previous counts so updateItem can detect 0 → positive transitions.
const _safeguardPrevCounts = new Map();

// ── HOOKS ─────────────────────────────────────────────────────────────────────

Hooks.on("renderCombatTracker", (app, html, data) => {
  const root = html instanceof HTMLElement ? html : html[0];
  if (!root) return;
  const $html = $(root);

  $html.find(".combatant").each((_, el) => {
    const $el = $(el);
    $el.find(".token-effects img").each((_, img) => {
      if (img.dataset.statusId !== "dead") img.remove();
    });
  });

  for (const li of root.querySelectorAll(".combatant")) {
    const combatantId = li.dataset.combatantId;
    const combatant   = game.combat.combatants.get(combatantId);
    const isUsed      = combatant.flags?.sotc?.used;
    const controls    = li.querySelector(".combatant-controls");
    if (!controls) continue;

    const usedButton = document.createElement("a");
    usedButton.classList.add("combatant-control");
    usedButton.dataset.control  = "toggleUsedSpeedDie";
    usedButton.dataset.tooltip  = "Toggle Speed Dice as Used/Unused";
    usedButton.setAttribute("aria-label", "Toggle Speed Dice as Used/Unused");
    usedButton.setAttribute("role", "button");

    const icon   = document.createElement("img");
    icon.src     = isUsed ? "systems/sotc/assets/icons/used.png" : "systems/sotc/assets/icons/unused.png";
    icon.alt     = "Used Speed Die";
    icon.style.width  = "20px";
    icon.style.height = "20px";
    icon.classList.add("used_and_unused_icons");
    usedButton.appendChild(icon);

    if (combatant.isOwner || game.user.isPrimaryGM) {
      usedButton.addEventListener("click", async (ev) => {
        ev.preventDefault();
        await combatant.setFlag("sotc", "used", !isUsed);
      });
    } else {
      usedButton.style.pointerEvents = "none";
      usedButton.style.opacity       = "0.0";
    }

    controls.appendChild(usedButton);
    li.classList.toggle("used-speed-die", isUsed);
    li.style.opacity = isUsed ? "0.4" : "";
  }
});

Hooks.on("createCombatant", async (combatant, options, userId) => {
  if (typeof userId === "string") {
    if (userId !== game.user.id) return;
  } else {
    if (!game.user.isGM) return;
  }

  if (combatant.flags?.sotc?.isSpeedDieClone) return;
  const actor = combatant.actor;
  if (!actor || !actor.system?.speed_dice) return;

  let extra_dice = 0;
  for (const s of actor.items.filter(i =>
    i.type === "status" &&
    i.system?.condition === "passive" &&
    i.system?.target === "number of speed dice" &&
    Number(i.system?.count) > 0
  )) {
    const sign  = s.system.effect === "Decrease" ? -1 : 1;
    const flat  = Number(s.system.potency_flat ?? 0);
    const pot   = Number(s.system.potency ?? 0);
    const cnt   = Number(s.system.count ?? 0);
    extra_dice += (flat + pot * cnt) * sign;
  }

  const base_num_dice = Number(actor.system.speed_dice.num_dice ?? 1);
  const temp_num_dice = base_num_dice + extra_dice;
  if (temp_num_dice <= 1) return;

  const combat        = combatant.parent;
  const actorId       = actor.id;
  const tokenId       = combatant.tokenId;
  const combatantName = combatant.name;
  if (!combat) return;

  setTimeout(async () => {
    for (let i = 1; i < temp_num_dice; i++) {
      await combat.createEmbeddedDocuments("Combatant", [{
        actorId, tokenId,
        hidden:     false,
        initiative: null,
        name:       `${combatantName} #${i + 1}`,
        flags:      { sotc: { isSpeedDieClone: true, speedDieIndex: i } }
      }]);
    }
  }, 50);
});

Hooks.on("deleteCombatant", async (combatant, options, userId) => {
  const combat  = combatant.parent;
  const actorId = combatant.actorId;
  const tokenId = combatant.tokenId;
  if (!actorId || !tokenId) return;

  const toRemove = combat.combatants.filter(c =>
    c.actorId === actorId &&
    c.tokenId === tokenId &&
    c.id      !== combatant.id &&
    c.getFlag("sotc", "isSpeedDieClone")
  );
  if (toRemove.length > 0) {
    await combat.deleteEmbeddedDocuments("Combatant", toRemove.map(c => c.id));
  }
});

Hooks.on("preRollInitiative", (combat, combatants, rollOptions) => {
  for (let combatant of combatants) {
    const actor       = combatant.actor;
    const actorFormula = actor?.system?.speed_dice?.dice_size;
    const actorType   = actor?.system?.initiative_type;

    if (actorFormula && Roll.validate(actorFormula)) {
      rollOptions.formula = actorType === "player"
        ? actorFormula + 0.01
        : actorFormula;
    }
  }
});

Hooks.on("combatRound", async (combat, round) => {
  if (!game.user.isGM || !game.users.activeGM?.isSelf) return;

  const combatant_updates  = [];
  const processed_actors   = new Set();

  for (let c of combat.combatants) {
    const actor_updates      = {};
    const actor_stag_updates = {};
    const actor              = c.actor;

    if (!actor?.system?.speed_dice) continue;

    const stag_status_updates = [];
    const stag_statuses = actor.items.filter(i =>
      i.type === "status" && i.system.condition === "stagger_like" && i.system.count > 0
    );
    for (const stag_status of stag_statuses) {
      if (round.round >= stag_status.system.stagger_end) {
        if (stag_status.system.stagger_effects?.reset_stagger) {
          actor_stag_updates["system.stagger.value"] = actor.system.stagger.max;
        }
        stag_status_updates.push({ _id: stag_status.id, "system.count": 0 });
      }
    }
    if (stag_status_updates.length) await actor.updateEmbeddedDocuments("Item", stag_status_updates);

    const modifiers = actor.system.modifiers ?? {};
    if (!modifiers.null_speed_dice) {
      combatant_updates.push({
        _id:             c.id,
        initiative:      null,
        "flags.sotc.used": false
      });
    }

    if (processed_actors.has(actor.id)) continue;
    processed_actors.add(actor.id);

    const status_updates = [];
    const statuses = actor.items.filter(i =>
      i.type === "status" && i.system.condition !== "stagger_like" && i.system.count > 0
    );

    const pre_flush_speed_dice_ids = new Set(
      statuses
        .filter(i => i.system?.condition === "passive" && i.system?.target === "number of speed dice")
        .map(i => i.id)
    );

    let accumulated_hp_delta  = 0, accumulated_hp_min   = 0;
    let accumulated_stg_delta = 0, accumulated_stg_min  = 0;
    let hp_affected  = false;
    let stg_affected = false;

    for (const status of statuses) {
      if (["haste", "bind"].includes(status.name.toLowerCase())) continue;

      const _use_duration = status.system.use_duration ?? false;
      const _stagger_end  = Number(status.system.stagger_end ?? 0);
      const _duration     = Number(status.system.stagger_duration ?? 0);
      const _condition    = status.system.condition;

      if (_use_duration && _duration > 0 && _stagger_end > 0 && round.round >= _stagger_end &&
          (_condition === "passive" || _condition === "stagger_like")) {
        status_updates.push({ _id: status.id, "system.count": 0, "system.stagger_end": null });
        continue;
      }

      const endOp = status.system.scene_end_effect?.operator;

      if (status.name.toLowerCase() === "sinking" || status.name.toLowerCase() === "sinking deluge") {
        const inflict      = Number(status.system.count ?? 0);
        if (inflict > 0) {
          const curr         = Number(actor.system.stagger.value ?? 0);
          const maxs         = Number(actor.system.stagger.max   ?? curr);
          const sinkingFloor = Number(status.system.scene_end_effect?.min_resource_limit ?? 0);
          actor_stag_updates["system.stagger.value"] = Math.max(sinkingFloor, Math.min(maxs, curr - inflict));
          const newc = Math.floor(inflict / 2);
          status_updates.push({ _id: status.id, "system.count": newc });

          const isPlayer        = actor.system.initiative_type === "player";
          const playerEPEnabled = game.settings.get("sotc", "sinkingPlayerEmotionPoints");
          const enemyEPEnabled  = game.settings.get("sotc", "sinkingEnemyEmotionPoints");
          if ((isPlayer && playerEPEnabled) || (!isPlayer && enemyEPEnabled)) {
            const cure = Number(actor.system.emotion ?? 0);
            actor_updates["system.emotion"] = Math.max(0, cure - Math.floor(inflict / 2));
          }
        }
      } else if (endOp && endOp !== "maintain") {
        const effect_type = status.system.effect;
        const flat_change = Number(status.system.potency_flat ?? 0);
        const potency     = Number(status.system.potency ?? 1);
        const count       = Number(status.system.count ?? 0);
        const delta       = count * potency + flat_change;
        const sign        = effect_type === "Decrease" ? -1 : 1;
        const minLimit    = Number(status.system.scene_end_effect?.min_resource_limit ?? 0);

        if (status.system.target === "hp" || status.system.target === "hp_stagger") {
          accumulated_hp_delta += delta * sign;
          accumulated_hp_min    = Math.max(accumulated_hp_min, minLimit);
          hp_affected = true;
        }
        if (status.system.target === "stagger" || status.system.target === "hp_stagger") {
          accumulated_stg_delta += delta * sign;
          accumulated_stg_min    = Math.max(accumulated_stg_min, minLimit);
          stg_affected = true;
        }
      }

      if (endOp === "clear") {
        status_updates.push({ _id: status.id, "system.count": 0 });
      } else if (endOp && endOp !== "maintain") {
        const new_count = applyOperator(status.system.count, endOp, status.system.scene_end_effect.variable);
        status_updates.push({ _id: status.id, "system.count": Math.max(new_count, 0) });
      }
    }

    if (hp_affected) {
      actor_updates["system.health.value"] = Math.max(accumulated_hp_min,
        (actor.system.health.value ?? 0) + accumulated_hp_delta);
    }
    if (stg_affected) {
      actor_updates["system.stagger.value"] = Math.max(accumulated_stg_min,
        (actor.system.stagger.value ?? 0) + accumulated_stg_delta);
    }

    if (status_updates.length) await actor.updateEmbeddedDocuments("Item", status_updates);

    // Recompute speed dice clones after status expiry
    {
      const speed_dice_expired = pre_flush_speed_dice_ids.size > 0 &&
        status_updates.some(u => pre_flush_speed_dice_ids.has(u._id));

      if (speed_dice_expired) {
        let expected_extra = 0;
        for (const s of actor.items.filter(i =>
          i.type === "status" &&
          i.system?.condition === "passive" &&
          i.system?.target === "number of speed dice" &&
          Number(i.system?.count) > 0
        )) {
          const sign = s.system.effect === "Decrease" ? -1 : 1;
          expected_extra += (Number(s.system.potency_flat ?? 0) + Number(s.system.potency ?? 0) * Number(s.system.count ?? 0)) * sign;
        }
        expected_extra = Math.max(0, expected_extra);

        const base_num_dice   = Number(actor.system.speed_dice?.num_dice ?? 1);
        const expected_clones = base_num_dice - 1 + expected_extra;
        const clones = combat.combatants.filter(c =>
          c.actorId === actor.id && c.getFlag("sotc", "isSpeedDieClone")
        );
        if (clones.length > expected_clones) {
          const excess = clones.slice(expected_clones);
          await combat.deleteEmbeddedDocuments("Combatant", excess.map(c => c.id));
        }
      }
    }

    // Light regen (inline, avoids stale modifiers cache)
    let inline_light_regen_mod = 0;
    for (const s of actor.items.filter(i =>
      i.type === "status" &&
      i.system.condition === "passive" &&
      i.system.target === "light regen" &&
      Number(i.system.count) > 0
    )) {
      const sign = s.system.effect === "Decrease" ? -1 : 1;
      inline_light_regen_mod += (Number(s.system.potency_flat ?? 0) + Number(s.system.potency ?? 0) * Number(s.system.count ?? 0)) * sign;
    }

    const light = actor.system.light;
    if (!modifiers.null_light_regen) {
      const current    = Number(light.value) || 0;
      const base_regen = Number(light.light_regen) || 0;
      const regen      = base_regen + inline_light_regen_mod;
      const max        = Number(light.max) || current;

      if (regen !== 0 && current < max) {
        actor_updates["system.light.value"] = Math.min(current + regen, max);
      }
    }

    Object.assign(actor_updates, actor_stag_updates);
    if (Object.keys(actor_updates).length) await game.sotc.updateActor(actor, actor_updates);
  }

  if (combatant_updates.length) {
    await combat.updateEmbeddedDocuments("Combatant", combatant_updates);
  }
});

Hooks.on("deleteCombat", async (combat) => {
  const restoreStagger = game.settings.get("sotc", "restoreStaggerOnCombatEnd");
  const restoreLight   = game.settings.get("sotc", "restoreLightOnCombatEnd");
  if (!restoreStagger && !restoreLight) return;
  if (!game.user.isGM || !game.users.activeGM?.isSelf) return;

  const processed    = new Set();
  const restoredNames = [];

  for (const c of combat.combatants) {
    const actor = c.actor;
    if (!actor) continue;
    if (processed.has(actor.id)) continue;
    processed.add(actor.id);

    const updates = {};
    if (restoreStagger) { const max = actor.system.stagger?.max ?? 0; if (max > 0) updates["system.stagger.value"] = max; }
    if (restoreLight)   { const max = actor.system.light?.max   ?? 0; if (max > 0) updates["system.light.value"]   = max; }

    if (Object.keys(updates).length) {
      await actor.update(updates);
      restoredNames.push(actor.name);
    }
  }

  if (restoredNames.length) {
    const parts = [];
    if (restoreStagger) parts.push("stagger");
    if (restoreLight)   parts.push("light");
    ChatMessage.create({
      content: `<div style="background:#12111a; border:1px solid #3a3050; border-radius:6px; padding:10px 12px; font-family:'Signika',sans-serif;">
        <strong style="color:#c9a227;">Combat Ended</strong>
        <div style="color:#aaa; font-size:12px; margin-top:4px;">
          Restored ${parts.join(" and ")} for: <span style="color:#ddd;">${restoredNames.join(", ")}</span>
        </div>
      </div>`
    });
  }
});

// ── TokenHUD override (status icon click → increment/decrement count) ─────────
Hooks.once("ready", () => {
  const TokenHUD         = foundry.applications.hud.TokenHUD;
  const originalToggle   = TokenHUD.prototype._onToggleEffect;

  TokenHUD.prototype._onToggleEffect = async function (event) {
    const img      = event.currentTarget;
    const statusId = img?.dataset?.statusId;
    if (!statusId) return originalToggle.call(this, event);

    const token = this.object;
    const actor = token?.actor;
    if (!actor) return originalToggle.call(this, event);

    if (SOTC_BASE_EFFECTS.has(statusId)) return originalToggle.call(this, event);

    const item = actor.items.get(statusId);
    if (!item || item.type !== "status") return originalToggle.call(this, event);

    event.preventDefault();
    event.stopImmediatePropagation();

    const current      = Number(item.system.count ?? 0);
    const isRightClick = event.button === 2;

    if (item.system.condition === "stagger_like") {
      await item.update({ "system.count": current > 0 ? 0 : 1 });
      return;
    }

    if (isRightClick) {
      await item.update({ "system.count": Math.max(current - 1, 0) });
    } else {
      await item.update({ "system.count": current + 1 });
    }
  };

  // Patch Token.drawEffects to add count badges
  const Token                = foundry.canvas.placeables.Token;
  const originalDrawEffects  = Token.prototype.drawEffects;
  Token.prototype.drawEffects = async function (...args) {
    await originalDrawEffects.apply(this, args);
    const token = this;
    requestAnimationFrame(() => drawCountBadges(token));
  };
});

Hooks.on("renderTokenHUD", (hud, html, data) => {
  const el = html instanceof HTMLElement ? html : html[0];

  requestAnimationFrame(() => {
    const effectsButton = el.querySelector('[data-action="effects"]');
    if (!effectsButton) return;
    const effectsPanel = effectsButton.querySelector(".status-effects");
    if (!effectsPanel) return;

    const token = canvas.tokens.get(data._id);
    const actor = token?.actor;
    if (!actor) return;

    effectsPanel.innerHTML = "";

    const activeStatuses = new Set();
    for (const effect of actor.effects.contents) {
      if (!effect.statuses) continue;
      for (const id of effect.statuses) activeStatuses.add(id);
    }

    for (const eff of CONFIG.statusEffects) {
      if (!SOTC_BASE_EFFECTS.has(eff.id)) continue;
      const img         = document.createElement("img");
      img.classList.add("effect-control");
      img.src           = eff.icon;
      img.title         = eff.label;
      img.dataset.statusId = eff.id;
      if (activeStatuses.has(eff.id)) img.classList.add("active");
      effectsPanel.appendChild(img);
    }

    for (const item of actor.items.filter(i => i.type === "status")) {
      const img         = document.createElement("img");
      img.classList.add("effect-control");
      img.src           = item.img;
      img.title         = item.name;
      img.dataset.statusId = item.id;
      if (activeStatuses.has(item.id)) img.classList.add("active");
      effectsPanel.appendChild(img);
    }
  });
});

Hooks.on("canvasReady", () => {
  setTimeout(() => {
    for (const token of canvas.tokens.placeables) token.drawEffects();
  }, 500);
});

Hooks.on("createToken", async (tokenDoc, options, userId) => {
  if (game.user.id !== userId) return;
  await new Promise(r => setTimeout(r, 300));
  const token = tokenDoc.object;
  if (token) token.drawEffects();
});

// ── Item lifecycle hooks ──────────────────────────────────────────────────────

Hooks.on("preUpdateItem", (item, changes) => {
  if (item.type !== "status") return;
  if (!["debuff", "ailment"].includes(item.system?.types)) return;
  if (changes.system?.count === undefined) return;
  _safeguardPrevCounts.set(item.id, Number(item.system?.count ?? 0));
});

Hooks.on("createItem", async (item) => {
  if (item.type !== "status") return;
  const actor = item.actor;
  if (!actor) return;
  if (!["debuff", "ailment"].includes(item.system?.types)) return;
  const count = Number(item.system?.count ?? 0);
  if (count <= 0) return;
  await _notifySafeguard(actor, item, count, count); // prevCount=0, so delta=count
});

Hooks.on("createItem", async (item) => {
  await syncStatusItemEffect(item);
  if (item.type === "status") {
    const count = Number(item.system?.count ?? 0);
    if (count > 0) await spawnSpeedDiceClones(item, count);
  }
});

Hooks.on("updateItem", async (item, changes) => {
  if (item.type !== "status") return;

  const countChanged = changes.system?.count !== undefined;

  if (countChanged) {
    const newCount  = Number(changes.system.count);
    const prevCount = _safeguardPrevCounts.get(item.id) ?? Number(item.system?.count ?? 0);
    _safeguardPrevCounts.delete(item.id);
    const actor = item.actor;
    if (newCount > prevCount && newCount > 0 && actor &&
        ["debuff", "ailment"].includes(item.system?.types)) {
      await _notifySafeguard(actor, item, newCount, newCount - prevCount);
    }
  }

  if (changes.system?.use_duration === false && Number(item.system.stagger_end ?? 0) > 0) {
    await item.update({ "system.stagger_end": null }, { diff: true });
  }

  if (countChanged) {
    const newCount       = Number(changes.system.count);
    const condition      = item.system.condition;
    const use_duration   = item.system.use_duration ?? false;
    const duration       = Number(item.system.stagger_duration ?? 0);
    const alreadyStamped = Number(item.system.stagger_end ?? 0) > 0;

    if (use_duration && newCount > 0 && duration > 0 && !alreadyStamped &&
        (condition === "passive" || condition === "stagger_like")) {
      const applied_round = game.combat?.round ?? 0;
      await item.update({ "system.stagger_end": applied_round + duration }, { diff: true });
    }

    if (newCount > 0) {
      await spawnSpeedDiceClones(item, newCount);
    } else if (
      newCount <= 0 &&
      item.system?.condition === "passive" &&
      item.system?.target === "number of speed dice" &&
      game.combat?.active &&
      (() => {
        const a = item.actor;
        if (!a) return false;
        const OWNER_LEVEL = 3;
        const owner = game.users.find(u =>
          !u.isGM && u.active &&
          (a.ownership[u.id] === OWNER_LEVEL || a.ownership.default === OWNER_LEVEL)
        );
        return owner
          ? game.user.id === owner.id
          : (game.user.isGM && game.users.activeGM?.isSelf);
      })()
    ) {
      const actor = item.actor;
      if (actor) {
        let expected_extra = 0;
        for (const s of actor.items.filter(i =>
          i.type === "status" && i.id !== item.id &&
          i.system?.condition === "passive" &&
          i.system?.target === "number of speed dice" &&
          Number(i.system?.count) > 0
        )) {
          const sign = s.system.effect === "Decrease" ? -1 : 1;
          expected_extra += (Number(s.system.potency_flat ?? 0) + Number(s.system.potency ?? 0) * Number(s.system.count ?? 0)) * sign;
        }
        expected_extra    = Math.max(0, expected_extra);
        const base_num_dice   = Number(actor.system.speed_dice?.num_dice ?? 1);
        const expected_clones = base_num_dice - 1 + expected_extra;
        const clones = game.combat.combatants.filter(c =>
          c.actorId === actor.id && c.getFlag("sotc", "isSpeedDieClone")
        );
        if (clones.length > expected_clones) {
          const excess   = clones.slice(expected_clones);
          const validIds = excess.map(c => c.id).filter(id => game.combat.combatants.has(id));
          if (validIds.length && game.user.isGM && game.users.activeGM?.isSelf) {
            await game.combat.deleteEmbeddedDocuments("Combatant", validIds).catch(() => {});
          }
        }
      }
    }
  }

  await syncStatusItemEffect(item);
});

Hooks.on("deleteItem", async (item) => {
  if (item.type !== "status") return;
  const actor = item.actor;
  if (!actor) return;

  const OWNER_LEVEL = 3;
  const designatedOwner = game.users.find(u =>
    !u.isGM && u.active &&
    (actor.ownership[u.id] === OWNER_LEVEL || actor.ownership.default === OWNER_LEVEL)
  );
  if (designatedOwner) {
    if (game.user.id !== designatedOwner.id) return;
  } else {
    const isActiveGM = game.user.isGM && game.users.activeGM?.isSelf;
    if (!isActiveGM) return;
  }

  const effect = getActorStatusEffect(actor, item.id);
  if (effect && actor.effects.has(effect.id)) {
    try { await effect.delete(); }
    catch (err) { console.warn(`sotc | deleteItem: could not delete effect for ${item.name}:`, err.message); }
  }

  if (
    item.system?.condition === "passive" &&
    item.system?.target    === "number of speed dice" &&
    game.combat?.active &&
    (designatedOwner
      ? game.user.id === designatedOwner.id
      : (game.user.isGM && game.users.activeGM?.isSelf))
  ) {
    let expected_extra = 0;
    for (const s of actor.items.filter(i =>
      i.type === "status" && i.id !== item.id &&
      i.system?.condition === "passive" &&
      i.system?.target === "number of speed dice" &&
      Number(i.system?.count) > 0
    )) {
      const sign = s.system.effect === "Decrease" ? -1 : 1;
      expected_extra += (Number(s.system.potency_flat ?? 0) + Number(s.system.potency ?? 0) * Number(s.system.count ?? 0)) * sign;
    }
    expected_extra    = Math.max(0, expected_extra);
    const base_num_dice   = Number(actor.system.speed_dice?.num_dice ?? 1);
    const expected_clones = base_num_dice - 1 + expected_extra;
    const clones = game.combat.combatants.filter(c =>
      c.actorId === actor.id && c.getFlag("sotc", "isSpeedDieClone")
    );
    if (clones.length > expected_clones) {
      const excess   = clones.slice(expected_clones);
      const validIds = excess.map(c => c.id).filter(id => game.combat.combatants.has(id));
      if (validIds.length && game.user.isGM && game.users.activeGM?.isSelf) {
        await game.combat.deleteEmbeddedDocuments("Combatant", validIds).catch(() => {});
      }
    }
  }
});
