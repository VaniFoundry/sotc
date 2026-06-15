/**
 * damage.js — SotC Damage Resolution, Chat Hooks & Token Trackers
 *
 * Covers:
 *  - openDamageWizard / resolveDamage (the full Damage Wizard flow)
 *  - applyStats / applyAffinities / normaliseType helpers
 *  - renderChatMessage hook (enemy reveal auto-tracking, clash/init collapse
 *    toggles, undo, safeguard yes/no, reroll-die, resolve-die, apply-status)
 *  - EGO Passive Tracker (_egoPassiveTracker)
 *  - Enemy Reveal Tracker (_enemyRevealTracker)
 *  - Shared canvas stage listener (_installSharedTrackerListener)
 *  - createActor hook (seed default statuses from compendium)
 *  - renderDialog hook (auto-select name field)
 *  - Drag-sort / active EGO styles injection
 *
 * Depends on game.sotc.updateActor and game.sotc.enrichModWithStatusIcons
 * being available (set up in sotc.js ready hook before these run).
 */

import { enrichModWithStatusIcons } from "./helper.js";

// ── Type helpers ──────────────────────────────────────────────────────────────

function normaliseType(t) {
  return (t || "").replace(/^counter-/, "");
}

function isOffensiveType(t) {
  return ["slash", "pierce", "blunt"].includes(normaliseType(t));
}

function isDefensiveType(t) {
  return ["block", "evade"].includes(normaliseType(t));
}

function resolveAttackerActor(payload) {
  if (payload.actorId) {
    const a = game.actors.get(payload.actorId);
    if (a) return a;
  }
  return canvas.tokens?.controlled?.[0]?.actor ?? null;
}

/**
 * Apply slash/pierce/blunt affinity modifiers to base damage and stagger.
 * Returns [finalDamage, finalStagger].
 */
function applyAffinities(actor, dieBase, baseDmg, baseStagger) {
  const m = actor.system.modifiers;
  if (dieBase === "slash") {
    return [
      Math.max(0, baseDmg     + (m.slash_damage_affinity  ?? 0)),
      Math.max(0, baseStagger + (m.slash_stagger_affinity ?? 0))
    ];
  } else if (dieBase === "pierce") {
    return [
      Math.max(0, baseDmg     + (m.pierce_damage_affinity  ?? 0)),
      Math.max(0, baseStagger + (m.pierce_stagger_affinity ?? 0))
    ];
  } else {
    return [
      Math.max(0, baseDmg     + (m.blunt_damage_affinity  ?? 0)),
      Math.max(0, baseStagger + (m.blunt_stagger_affinity ?? 0))
    ];
  }
}

/**
 * Apply stat changes to an actor, routed through game.sotc.updateActor
 * so players can affect tokens they don't own.
 */
async function applyStats(actor, { dmg = 0, stagger = 0, staggerGain = 0 } = {}) {
  if (!dmg && !stagger && !staggerGain) return;
  const delta = {};
  if (dmg         > 0) delta.hp           = -dmg;
  if (stagger     > 0) delta.stagger      = -stagger;
  if (staggerGain > 0) delta.staggerGain  =  staggerGain;
  await game.sotc.updateActor(actor, delta);
}

// ── openDamageWizard ──────────────────────────────────────────────────────────

export async function openDamageWizard(payload) {
  if (!game.user.isGM && !game.settings.get("sotc", "playerDamageWizard")) {
    return ui.notifications.warn("The Damage Wizard is currently restricted to the GM.");
  }

  const targets = Array.from(game.user.targets);
  if (!targets.length) return ui.notifications.warn("Select a target first!");

  const token   = targets[0];
  const dieBase = normaliseType(payload.dieType);

  const badgeColor = isOffensiveType(dieBase) ? "#7a1a1a"
                   : dieBase === "block"       ? "#1a3f7a"
                   :                             "#1a5e35";

  const dieButtons = [
    { value: "none",   label: "None",   icon: null,                                         color: "#444"    },
    { value: "slash",  label: "Slash",  icon: "systems/sotc/assets/dice types/slash.png",  color: "#8b1a1a" },
    { value: "pierce", label: "Pierce", icon: "systems/sotc/assets/dice types/pierce.png", color: "#7a3a00" },
    { value: "blunt",  label: "Blunt",  icon: "systems/sotc/assets/dice types/blunt.png",  color: "#5a4a00" },
    { value: "block",  label: "Block",  icon: "systems/sotc/assets/dice types/block.png",  color: "#1a3f7a" },
    { value: "evade",  label: "Evade",  icon: "systems/sotc/assets/dice types/evade.png",  color: "#1a5e35" },
  ];

  const btnHTML = dieButtons.map((b, i) => `
    <button type="button"
      class="sotc-die-btn"
      data-value="${b.value}"
      data-accent="${b.color}"
      style="
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        gap:4px; padding:6px 4px; border-radius:6px; cursor:pointer;
        border:2px solid ${i === 0 ? b.color : "transparent"};
        background:${i === 0 ? b.color + "33" : "#1e1b2e"};
        color:${i === 0 ? "#fff" : "#aaa"};
        font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em;
        flex:1; min-width:0;
      "
      onclick="
        this.closest('.sotc-wizard-wrap').querySelectorAll('.sotc-die-btn').forEach(el => {
          el.style.borderColor = 'transparent';
          el.style.background  = '#1e1b2e';
          el.style.color       = '#aaa';
        });
        this.style.borderColor = this.dataset.accent;
        this.style.background  = this.dataset.accent + '33';
        this.style.color       = '#fff';
        this.closest('.sotc-wizard-wrap').querySelector('[name=defender_die_type]').value = this.dataset.value;
      "
    >
      ${b.icon
        ? `<img src="${b.icon}" style="width:28px;height:28px;border:none;object-fit:contain;" />`
        : `<span style="font-size:18px;line-height:28px;color:#888;">✕</span>`
      }
      ${b.label}
    </button>
  `).join("");

  const INPUT_STYLE = `background:#f5f0e8; color:#1a1a1a; border:1px solid #8a7a5a; border-radius:4px; padding:5px 8px; width:100%; box-sizing:border-box; font-size:14px; margin-top:3px;`;
  const LABEL_STYLE = `display:block; font-weight:600; color:#c9a227; font-size:11px; text-transform:uppercase; letter-spacing:0.06em; margin-top:10px;`;

  const _isOff     = isOffensiveType(normaliseType(payload.dieType));
  const _tActor    = token.actor;
  const _aActor    = resolveAttackerActor(payload);
  const _thornsItem = _isOff ? _tActor?.items.find(i =>
    i.type === "status" && i.system?.condition === "special" &&
    i.system?.special_trigger === "on_receive_damage" && Number(i.system?.count ?? 0) > 0
  ) : null;
  const _bleedItem = _isOff ? _aActor?.items.find(i =>
    i.type === "status" && i.name.toLowerCase() === "bleed" && Number(i.system?.count ?? 0) > 0
  ) : null;
  const _thornCount = _thornsItem ? Number(_thornsItem.system.count) : 0;
  const _bleedCount = _bleedItem  ? Number(_bleedItem.system.count)  : 0;

  const critCheckboxHtml = _thornsItem ? [
    '<label style="' + LABEL_STYLE + ' flex-direction:row; align-items:center; gap:8px; margin-top:10px;">',
    '  <input type="checkbox" name="is_crit" style="width:16px; height:16px; cursor:pointer; margin:0;" />',
    '  <span>Critical Hit',
    '    <span style="font-weight:400; color:#888; font-size:10px;">',
    '      <img src="' + (_thornsItem.img || 'systems/sotc/assets/statuses/Thorns.png') + '"',
    '           style="width:12px;height:12px;border:none;object-fit:contain;vertical-align:middle;margin-right:2px;">',
    '      doubles Thorns damage &mdash; target has ' + _thornCount + ' Thorns',
    '    </span>',
    '  </span>',
    '</label>',
  ].join("") : "";

  const bleedCheckboxHtml = _bleedItem ? [
    '<label style="' + LABEL_STYLE + ' flex-direction:row; align-items:center; gap:8px; margin-top:8px;">',
    '  <input type="checkbox" name="suppress_bleed" style="width:16px; height:16px; cursor:pointer; margin:0;" />',
    '  <span>Suppress Bleed',
    '    <span style="font-weight:400; color:#888; font-size:10px;">',
    '      <img src="systems/sotc/assets/statuses/Bleed.png"',
    '           style="width:12px;height:12px;border:none;object-fit:contain;vertical-align:middle;margin-right:2px;">',
    '      skip Bleed this attack &mdash; attacker has ' + _bleedCount + ' Bleed',
    '    </span>',
    '  </span>',
    '</label>',
  ].join("") : "";

  const content = `
    <style>
      .sotc-wizard-wrap { font-family:"Signika",sans-serif; padding:4px 2px; }
      .sotc-wizard-header {
        display:flex; align-items:center; gap:10px;
        background:#1e1b2e; border:1px solid #4a3f6b;
        border-radius:8px; padding:10px 14px; margin-bottom:10px;
      }
      .sotc-wizard-badge {
        background:${badgeColor}; color:#fff; border-radius:4px;
        padding:2px 8px; font-size:11px; font-weight:700;
        text-transform:uppercase; letter-spacing:0.08em; white-space:nowrap;
      }
      .sotc-wizard-name  { color:#e8d9a0; font-weight:700; font-size:14px; flex:1; }
      .sotc-wizard-total { color:#fff; font-size:22px; font-weight:900; min-width:32px; text-align:right; }
      .sotc-section { background:#12111a; border:1px solid #3a3050; border-radius:6px; padding:10px 12px; }
      .sotc-die-btn:hover { opacity:0.85; }
      .sotc-wizard-hint  { color:#888; font-size:11px; margin-top:3px; display:block; }
    </style>
    <div class="sotc-wizard-wrap">
      <div class="sotc-wizard-header">
        <span class="sotc-wizard-badge">${payload.dieType}</span>
        <span class="sotc-wizard-name">${payload.itemName}</span>
        <span class="sotc-wizard-total">${payload.total}</span>
      </div>
      <div class="sotc-section">
        <label style="${LABEL_STYLE}">Check Modifier (Attacker's Roll)
          <input type="number" name="mod" value="0" style="${INPUT_STYLE}" />
        </label>
        <label style="${LABEL_STYLE} margin-bottom:6px;">Opposing Die Type</label>
        <input type="hidden" name="defender_die_type" value="none" />
        <div style="display:flex; gap:5px; margin-top:2px;">
          ${btnHTML}
        </div>
        <div style="display:flex; gap:8px; margin-top:10px;">
          <div style="flex:1;">
            <label style="${LABEL_STYLE} margin-top:0;">Opposing Die Roll</label>
            <input type="number" name="defender_die" value="0" min="0" style="${INPUT_STYLE}"
              oninput="this.closest('.sotc-wizard-wrap').querySelector('.sotc-opposing-total').textContent = (Number(this.value)||0) + (Number(this.closest('.sotc-wizard-wrap').querySelector('[name=defender_mod]').value)||0);" />
            <span class="sotc-wizard-hint">Leave at 0 for Unopposed</span>
          </div>
          <div style="flex:1;">
            <label style="${LABEL_STYLE} margin-top:0;">External Bonus</label>
            <input type="number" name="defender_mod" value="0" style="${INPUT_STYLE}"
              oninput="this.closest('.sotc-wizard-wrap').querySelector('.sotc-opposing-total').textContent = (Number(this.value)||0) + (Number(this.closest('.sotc-wizard-wrap').querySelector('[name=defender_die]').value)||0);" />
            <span class="sotc-wizard-hint">e.g. status modifiers</span>
          </div>
        </div>
        <div style="margin-top:6px; font-size:11px; color:#aaa;">Total Opposing: <strong class="sotc-opposing-total" style="color:#e8d9a0;">0</strong></div>
        ${critCheckboxHtml}
        ${bleedCheckboxHtml}
      </div>
    </div>
  `;

  new Dialog({
    title:   `Damage Wizard — ${payload.itemName}`,
    content,
    buttons: {
      resolve: {
        icon:     '<i class="fas fa-bolt"></i>',
        label:    "Resolve",
        callback: html => resolveDamage(payload, html, token)
      },
      cancel: {
        icon:  '<i class="fas fa-times"></i>',
        label: "Cancel"
      }
    },
    default: "resolve"
  }, { classes: ["sotc_damage_wizard"], width: 390 }).render({ force: true });
}

// ── resolveDamage ─────────────────────────────────────────────────────────────

async function resolveDamage(payload, html, targetToken) {
  if (!game.user.isGM && !game.settings.get("sotc", "playerDamageWizard")) {
    return ui.notifications.warn("The Damage Wizard is currently restricted to the GM.");
  }

  const targetActor   = targetToken.actor;
  const mod           = Number(html.find('[name="mod"]').val()                 || 0);
  const defenderType  =        html.find('[name="defender_die_type"]').val()   ?? "none";
  const defenderBase  = Number(html.find('[name="defender_die"]').val()        || 0);
  const defenderMod   = Number(html.find('[name="defender_mod"]').val()        || 0);
  const defenderRoll  = defenderBase + defenderMod;
  const isCrit        =        html.find('[name="is_crit"]').prop("checked")        ?? false;
  const suppressBleed =        html.find('[name="suppress_bleed"]').prop("checked") ?? false;

  const attackPower = payload.total + mod;

  const clashResult = defenderRoll === 0         ? "unopposed"
                    : attackPower > defenderRoll  ? "win"
                    : attackPower === defenderRoll ? "tie"
                    : "lose";

  const dieBase        = normaliseType(payload.dieType);
  const isOffensive    = isOffensiveType(dieBase);
  const isBlock        = dieBase === "block";
  const isEvade        = dieBase === "evade";
  const defIsOffensive = isOffensiveType(defenderType);
  const defIsBlock     = defenderType === "block" || defenderType === "counter-block";
  const defIsEvade     = defenderType === "evade" || defenderType === "counter-evade";

  const attackerActor = resolveAttackerActor(payload);

  let resultLabel = "";
  let tDmg = 0, tStagger = 0, tStaggerGain = 0;
  let aDmg = 0, aStagger = 0, aStaggerGain = 0;

  // ── OFFENSIVE ────────────────────────────────────────────────────────────────
  if (isOffensive) {
    switch (clashResult) {
      case "win":
      case "unopposed": {
        [tDmg, tStagger] = applyAffinities(targetActor, dieBase, attackPower, attackPower);
        if (clashResult === "win" && defIsBlock) { tDmg = Math.max(0, tDmg - defenderRoll); tStagger = Math.max(0, tStagger - defenderRoll); }
        if (clashResult === "win" && defIsEvade)  tStagger = Math.max(0, tStagger - defenderRoll);
        resultLabel = clashResult === "win"
          ? `Clash Win — dealt ${tDmg} damage and ${tStagger} stagger to ${targetActor.name}`
          : `Unopposed — dealt ${tDmg} damage and ${tStagger} stagger to ${targetActor.name}`;
        break;
      }
      case "tie":  { resultLabel = "Clash Tie — no effect."; break; }
      case "lose": {
        if (defIsBlock) {
          aStagger    = Math.max(0, defenderRoll - attackPower);
          resultLabel = `Clash Lose vs Block — ${targetActor.name}'s block dealt ${aStagger} stagger to ${attackerActor?.name ?? "attacker"} (no HP damage)`;
        } else if (defIsEvade) {
          resultLabel = `Clash Lose vs Evade — ${targetActor.name}'s evade recycled! No damage. They may re-deploy it.`;
        } else if (defIsOffensive && attackerActor) {
          const defBase = normaliseType(defenderType);
          [aDmg, aStagger] = applyAffinities(attackerActor, defBase, defenderRoll, defenderRoll);
          resultLabel = `Clash Lose vs Offensive — ${attackerActor.name} takes ${aDmg} damage and ${aStagger} stagger`;
        } else {
          resultLabel = "Clash Lose — no effect.";
        }
        break;
      }
    }
  }

  // ── BLOCK ─────────────────────────────────────────────────────────────────────
  else if (isBlock) {
    switch (clashResult) {
      case "win": {
        if (defIsOffensive) {
          const net = Math.max(0, attackPower - defenderRoll);
          tDmg = net; tStagger = net;
          resultLabel = `Block Clash Win vs Offensive — dealt ${tDmg} damage and ${tStagger} stagger to ${targetActor.name}`;
        } else {
          tStagger    = Math.max(0, attackPower - defenderRoll);
          resultLabel = `Block Clash Win — dealt ${tStagger} stagger to ${targetActor.name}`;
        }
        break;
      }
      case "tie":  { resultLabel = "Block Clash Tie — no effect."; break; }
      case "lose": {
        if (defIsOffensive && attackerActor) {
          const defBase  = normaliseType(defenderType);
          const netPower = Math.max(0, defenderRoll - attackPower);
          [aDmg, aStagger] = applyAffinities(attackerActor, defBase, netPower, netPower);
          resultLabel = `Block Clash Lose vs Offensive — blocked ${attackPower}, ${attackerActor.name} takes net ${aDmg} damage and ${aStagger} stagger`;
        } else if (defIsEvade) {
          tStaggerGain = Math.max(0, defenderRoll - attackPower);
          resultLabel  = `Block Clash Lose vs Evade — ${targetActor.name}'s evade wins, they regain ${tStaggerGain} stagger`;
        } else {
          resultLabel = "Block Clash Lose — no effect.";
        }
        break;
      }
      case "unopposed": {
        await targetToken.actor.setFlag("sotc", "savedBlock", { power: attackPower, source: payload.itemName });
        resultLabel = `Block Unopposed — die saved for later this scene (power: ${attackPower})`;
        break;
      }
    }
  }

  // ── EVADE ─────────────────────────────────────────────────────────────────────
  else if (isEvade) {
    switch (clashResult) {
      case "win": {
        if (defIsOffensive) {
          resultLabel = `Evade Clash Win vs Offensive — die recycled! No other Clash Win effects trigger.`;
        } else {
          aStaggerGain = Math.max(0, attackPower - defenderRoll);
          resultLabel  = `Evade Clash Win vs Defensive — ${attackerActor?.name ?? "Evader"} regains ${aStaggerGain} stagger`;
        }
        break;
      }
      case "tie":  { resultLabel = "Evade Clash Tie — no effect."; break; }
      case "lose": {
        if (defIsOffensive && attackerActor) {
          const defBase     = normaliseType(defenderType);
          const netStagger  = Math.max(0, defenderRoll - attackPower);
          const [rawDmg]       = applyAffinities(attackerActor, defBase, defenderRoll, 0);
          const [, affStagger] = applyAffinities(attackerActor, defBase, 0, netStagger);
          aDmg = rawDmg; aStagger = affStagger;
          resultLabel = `Evade Clash Lose vs Offensive — evade absorbed ${attackPower} stagger, ${attackerActor.name} takes ${aDmg} HP and ${aStagger} stagger`;
        } else if (defIsBlock) {
          aStagger    = Math.max(0, defenderRoll - attackPower);
          resultLabel = `Evade Clash Lose vs Block — ${attackerActor?.name ?? "Evader"} takes ${aStagger} stagger`;
        } else if (defIsEvade) {
          tStaggerGain = Math.max(0, defenderRoll - attackPower);
          resultLabel  = `Evade Clash Lose vs Evade — ${targetActor.name}'s evade wins, they regain ${tStaggerGain} stagger`;
        } else {
          resultLabel = "Evade Clash Lose — no effect.";
        }
        break;
      }
      case "unopposed": {
        await targetToken.actor.setFlag("sotc", "savedEvade", { power: attackPower, source: payload.itemName });
        resultLabel = `Evade Unopposed — die saved for later this scene (power: ${attackPower})`;
        break;
      }
    }
  }

  // ── Snapshot pre-apply state for undo ────────────────────────────────────────
  const attackerToken  = attackerActor
    ? canvas.tokens?.placeables?.find(t => t.actor?.id === attackerActor.id) ?? null
    : null;
  const freshAttacker  = attackerToken ? attackerToken.actor : attackerActor;

  const snapshot = {
    target: {
      actorId: targetActor.id,
      tokenId: targetToken?.id ?? null,
      hp:      targetActor.system.health.value  ?? 0,
      stagger: targetActor.system.stagger.value ?? 0,
    },
    attacker: freshAttacker ? {
      actorId: freshAttacker.id,
      tokenId: attackerToken?.id ?? null,
      hp:      freshAttacker.system.health.value  ?? 0,
      stagger: freshAttacker.system.stagger.value ?? 0,
    } : null,
  };

  // ── Apply stats ───────────────────────────────────────────────────────────────
  await applyStats(targetActor,   { dmg: tDmg, stagger: tStagger, staggerGain: tStaggerGain });
  if (attackerActor && (aDmg > 0 || aStagger > 0 || aStaggerGain > 0)) {
    await applyStats(attackerActor, { dmg: aDmg, stagger: aStagger, staggerGain: aStaggerGain });
  }

  // ── Bleed ─────────────────────────────────────────────────────────────────────
  const bleedStatLines = [];
  if (isOffensive && !suppressBleed && game.settings.get("sotc", "bleedAutoCalc") && attackerActor) {
    const bleedStatus = attackerActor.items.find(i =>
      i.type === "status" && i.name.toLowerCase() === "bleed" && Number(i.system?.count ?? 0) > 0
    );
    if (bleedStatus) {
      const bleedDmg = Number(bleedStatus.system.count);
      await applyStats(attackerActor, { dmg: bleedDmg });
      await bleedStatus.update({ "system.count": Math.max(0, bleedDmg - 1) });
      bleedStatLines.push(
        '<span style="color:#c03030;display:flex;align-items:center;gap:4px;">' +
        '<img src="systems/sotc/assets/statuses/Bleed.png" style="width:16px;height:16px;border:none;object-fit:contain;"> ' +
        'Bleed ' + bleedDmg + ' HP \u2192 ' + attackerActor.name +
        ' (Bleed ' + bleedDmg + '\u2192' + (bleedDmg - 1) + ')' +
        '</span>'
      );
    }
  }

  // ── Thorns ────────────────────────────────────────────────────────────────────
  const thornsStatLines = [];
  if (tDmg > 0 && attackerActor && isOffensive) {
    const thornsStatuses = targetActor.items.filter(i =>
      i.type === "status" &&
      i.system?.condition === "special" &&
      i.system?.special_trigger === "on_receive_damage" &&
      Number(i.system?.count ?? 0) > 0
    );
    for (const thorns of thornsStatuses) {
      let thornsDmg = Number(thorns.system.count);
      if (isCrit) thornsDmg *= 2;
      await applyStats(attackerActor, { dmg: thornsDmg });
      thornsStatLines.push(
        `<span style="color:#e07030;display:flex;align-items:center;gap:4px;"><img src="${thorns.img || 'systems/sotc/assets/statuses/Thorns.png'}" style="width:16px;height:16px;border:none;object-fit:contain;"> ${thorns.name} (${isCrit ? "CRIT × 2 = " + thornsDmg : thornsDmg}) HP → ${attackerActor.name}</span>`
      );
    }
  }

  // ── Emotion Points ────────────────────────────────────────────────────────────
  const epStatLines = [];
  if (clashResult !== "unopposed" && game.settings.get("sotc", "emotionPointAutoCalc")) {
    const enemyEpEnabled = game.settings.get("sotc", "enemyEmotionPoints");
    const epActors = [targetActor, attackerActor].filter(a => {
      if (!a) return false;
      if (a.system?.initiative_type === "player") return true;
      return enemyEpEnabled;
    });
    for (const a of epActors) {
      const currentEp = Number(a.system.emotion ?? 0);
      const maxEp     = Number(a.system.emotion_max ?? a.system.emotionMax ?? 99);
      const newEp     = Math.min(maxEp, currentEp + 1);
      if (newEp > currentEp) {
        await game.sotc.updateActor(a, { emotion: newEp - currentEp });
        epStatLines.push(`<span style="color:#c9a227;">+1 EP → ${a.name}</span>`);
      }
    }
  }

  // ── Build chat result ─────────────────────────────────────────────────────────
  const clashLabel = { win: "Clash Win", tie: "Clash Tie", lose: "Clash Lose", unopposed: "Unopposed" }[clashResult];
  const clashColor = { win: "#4caf7d",   tie: "#c9a227",  lose: "#e05050",    unopposed: "#aaa"       }[clashResult];

  const statLines = [];
  if (tDmg         > 0) statLines.push(`<span style="color:#e05050;">${tDmg} HP → ${targetActor.name}</span>`);
  if (tStagger      > 0) statLines.push(`<span style="color:#e0943a;">${tStagger} stagger → ${targetActor.name}</span>`);
  if (tStaggerGain  > 0) statLines.push(`<span style="color:#4caf7d;">+${tStaggerGain} stagger regained by ${targetActor.name}</span>`);
  if (aDmg          > 0) statLines.push(`<span style="color:#e05050;">${aDmg} HP → ${attackerActor?.name}</span>`);
  if (aStagger      > 0) statLines.push(`<span style="color:#e0943a;">${aStagger} stagger → ${attackerActor?.name}</span>`);
  if (aStaggerGain  > 0) statLines.push(`<span style="color:#4caf7d;">+${aStaggerGain} stagger regained by ${attackerActor?.name}</span>`);
  statLines.push(...epStatLines, ...bleedStatLines, ...thornsStatLines);

  const snapshotJson = JSON.stringify(snapshot).replace(/'/g, "&#39;");
  const hasEffect    = tDmg || tStagger || tStaggerGain || aDmg || aStagger || aStaggerGain || thornsStatLines.length;

  const previewStats = [];
  if (tDmg         > 0) previewStats.push(`<span style="color:#e05050;">${tDmg} HP</span>`);
  if (tStagger      > 0) previewStats.push(`<span style="color:#e0943a;">${tStagger} stagger</span>`);
  if (aDmg          > 0) previewStats.push(`<span style="color:#e05050;">${aDmg} HP → ${attackerActor?.name}</span>`);
  if (aStagger      > 0) previewStats.push(`<span style="color:#e0943a;">${aStagger} stagger → ${attackerActor?.name}</span>`);
  if (tStaggerGain  > 0) previewStats.push(`<span style="color:#4caf7d;">+${tStaggerGain} stagger back</span>`);
  if (aStaggerGain  > 0) previewStats.push(`<span style="color:#4caf7d;">+${aStaggerGain} stagger back</span>`);

  const previewPill = `
    <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
      <span style="background:#1a1a2a; color:${clashColor}; border:1px solid #3a3050; border-radius:4px; padding:1px 7px; font-size:11px; font-weight:700;">${payload.dieType} → ${attackPower} · ${clashLabel}</span>
      ${previewStats.length ? `<span style="font-size:11px; color:#aaa;">${previewStats.join('<span style="color:#555;"> · </span>')}</span>` : ""}
    </div>`;

  const dieRow = `
    <div class="sotc-clash-row" style="border-top:1px solid #2a2540; padding:7px 0 4px; margin-top:4px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3px;">
        <span style="background:#2a2040; color:#c9a227; border-radius:4px; padding:1px 7px; font-size:11px; font-weight:700;">${payload.dieType} → ${attackPower}</span>
        <span style="font-size:11px; font-weight:700; color:${clashColor};">${clashLabel}</span>
      </div>
      <div style="font-size:12px; color:#ccc; margin-bottom:3px;">${resultLabel}</div>
      ${statLines.length ? `<div style="display:flex; flex-direction:column; gap:1px; font-size:12px;">${statLines.join("")}</div>` : ""}
      ${hasEffect ? `
        <a class="sotc-undo-damage" data-snapshot='${snapshotJson}'
           style="display:inline-flex; align-items:center; gap:5px; background:#2a1a1a; border:1px solid #6b2a2a; border-radius:4px; padding:2px 8px; font-size:11px; font-weight:700; color:#e07070; text-transform:uppercase; letter-spacing:0.06em; cursor:pointer; text-decoration:none; margin-top:4px;">
          <i class="fas fa-rotate-left"></i> Undo
        </a>` : ""}
    </div>`;

  const sourceId = payload.sourceMessageId;
  const existing = sourceId
    ? game.messages.find(m => m.getFlag("sotc", "clashGroup") === sourceId)
    : null;

  if (existing) {
    const parser    = new DOMParser();
    const doc       = parser.parseFromString(existing.content, "text/html");
    const container = doc.querySelector(".sotc-clash-rows");
    const summary   = doc.querySelector(".sotc-clash-summary");
    if (container) {
      container.insertAdjacentHTML("beforeend", dieRow);
      if (summary) summary.innerHTML = previewPill;
      container.dataset.collapsed = "true";
      container.style.display     = "none";
      await existing.update({ content: doc.body.innerHTML });
    }
  } else {
    const headerContent = `
      <div style="background:#12111a; border:1px solid #3a3050; border-radius:6px; padding:10px 12px; font-family:'Signika',sans-serif; line-height:1.6;">
        <div class="sotc-clash-toggle" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; cursor:pointer; user-select:none;">
          <div style="display:flex; align-items:center; gap:6px;">
            <i class="fas fa-chevron-down sotc-clash-chevron" style="font-size:10px; color:#888; transition:transform 0.15s;"></i>
            <strong style="color:#e8d9a0; font-size:14px;">${payload.itemName}</strong>
          </div>
          <span style="color:#aaa; font-size:11px;">vs ${targetActor.name}</span>
        </div>
        <div class="sotc-clash-summary" style="margin-bottom:4px;">${previewPill}</div>
        <div class="sotc-clash-rows" data-collapsed="false">${dieRow}</div>
      </div>`;
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker(),
      content: headerContent,
      flags:   { sotc: { clashGroup: sourceId ?? foundry.utils.randomID() } }
    });
  }
}

// ── Shared apply-status helper (chat buttons + reveal tracker panel) ───────────
async function _applyStatusButton(ev, speakerActorId) {
  ev.preventDefault();
  const statusName = ev.currentTarget.dataset.statusName;
  const rawCount   = ev.currentTarget.dataset.statusCount;

  const speakerActor = speakerActorId ? game.actors.get(speakerActorId) : null;
  const sourceStatus =
    speakerActor?.items.find(i => i.type === "status" && i.name.toLowerCase() === statusName) ??
    game.items.find(i => i.type === "status" && i.name.toLowerCase() === statusName);

  if (!sourceStatus)
    return ui.notifications.warn(`No status item found for "${statusName}".`);

  const targets = [...game.user.targets];
  if (!targets.length)
    return ui.notifications.warn("No target selected. Right-click a token and target it first.");

  let stacksToAdd;
  if (rawCount && Number(rawCount) > 0) {
    stacksToAdd = Number(rawCount);
  } else {
    stacksToAdd = await new Promise(resolve => {
      new Dialog({
        title:   `Apply ${sourceStatus.name}`,
        content: `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
          <label style="flex-shrink:0;">Stacks to apply:</label>
          <input id="sotc-stack-input" type="number" min="1" value="1" style="width:60px;" autofocus />
        </div>`,
        buttons: {
          apply:  { icon: '<i class="fas fa-check"></i>',  label: "Apply",  callback: h => { const v = Number(h.find("#sotc-stack-input").val()); resolve(v > 0 ? v : 1); } },
          cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel", callback: () => resolve(null) }
        },
        default: "apply"
      }).render({ force: true });
    });
  }
  if (!stacksToAdd) return;

  for (const target of targets) {
    const targetActor = target.actor;
    if (!targetActor) continue;
    const existing = targetActor.items.find(i => i.type === "status" && i.name === sourceStatus.name);
    if (existing) {
      const newCount = (Number(existing.system.count) || 0) + stacksToAdd;
      await existing.update({ "system.count": newCount });
      ui.notifications.info(`${sourceStatus.name} on ${targetActor.name} → ${newCount}.`);
    } else {
      const newItem        = sourceStatus.toObject();
      newItem.system.count = stacksToAdd;
      await targetActor.createEmbeddedDocuments("Item", [newItem]);
      ui.notifications.info(`Applied ${stacksToAdd}x ${sourceStatus.name} to ${targetActor.name}.`);
    }
  }
}

// ── EGO Passive Tracker ───────────────────────────────────────────────────────

export const _egoPassiveTracker = {
  entriesByActor: new Map(),
  _tooltip:       null,

  _makeId() { return foundry.utils.randomID(8); },

  // Signature matches the enemy reveal tracker: add(actorId, entry).
  add(actorId, entry) {
    if (!this.entriesByActor.has(actorId))
      this.entriesByActor.set(actorId, []);
    const arr = this.entriesByActor.get(actorId);
    if (arr.some(e => e.egoId === entry.egoId)) {
      ui.notifications.info(`${entry.passiveName || entry.egoName} is already active.`);
      return;
    }
    arr.push({ ...entry, id: this._makeId() });
    this._renderForActor(actorId);
    this._installStageListener();
    if (this._panelActorId === actorId) this._rebuildPanelBody(actorId);
    this._save(actorId);
  },

  remove(actorId, id) {
    const arr = this.entriesByActor.get(actorId) ?? [];
    this.entriesByActor.set(actorId, arr.filter(e => e.id !== id));
    this._removeBadge(actorId);
    this._renderForActor(actorId);
    if (this._panelActorId === actorId) this._rebuildPanelBody(actorId);
    this._save(actorId);
  },

  clearAll(actorId) {
    this.entriesByActor.set(actorId, []);
    this._renderForActor(actorId);
    this._hidePanel();
    this._save(actorId);
  },

  async _save(actorId) {
    try {
      const entries = this.entriesByActor.get(actorId) ?? [];

      // game.socket.emit does NOT call back to the sender's own listener, so
      // if the sender is the active GM, persist directly here. Otherwise the
      // GM's socket listener in sotc.js persists it on receipt.
      if (game.user.isGM && game.users.activeGM?.isSelf) {
        try {
          let stored = {};
          try { stored = JSON.parse(game.settings.get("sotc", "egoPassiveData") || "{}"); } catch {}
          if (entries.length) stored[actorId] = entries;
          else delete stored[actorId];
          await game.settings.set("sotc", "egoPassiveData", JSON.stringify(stored));
        } catch (e) { console.warn("sotc | EGO tracker: could not persist:", e); }
      }

      // Broadcast to all other connected clients so their badges update immediately.
      game.socket.emit("system.sotc", { type: "egoPassiveSync", actorId, entries });
    } catch (e) { console.warn("sotc | EGO tracker: could not save:", e); }
  },

  _loadAll() {
    try {
      const data = JSON.parse(game.settings.get("sotc", "egoPassiveData") || "{}");
      for (const [actorId, entries] of Object.entries(data)) {
        if (entries?.length) this.entriesByActor.set(actorId, entries);
      }
    } catch (e) { console.warn("sotc | EGO tracker: could not load:", e); }
  },

  // Called on all clients when a socket sync message arrives.
  // `entries` comes directly from the socket payload — don't re-read the
  // world setting here because non-GM senders never write to it.
  syncActor(actorId, entries) {
    try {
      if (entries?.length) this.entriesByActor.set(actorId, entries);
      else this.entriesByActor.delete(actorId);
      this._removeBadge(actorId);
      this._renderForActor(actorId);
      this._installStageListener();
      if (this._panelActorId === actorId) this._rebuildPanelBody(actorId);
    } catch (e) { console.warn("sotc | EGO tracker: syncActor failed:", e); }
  },

  async _printToChat(actorId) {
    const actor   = game.actors.get(actorId)
      ?? (canvas?.tokens?.placeables ?? []).find(t => t.actor?.id === actorId)?.actor;
    const entries = this.entriesByActor.get(actorId) ?? [];
    if (!entries.length) return;
    const rows = entries.map(e => {
      const enrichedText = game.sotc?.enrichModWithStatusIcons
        ? game.sotc.enrichModWithStatusIcons(e.passiveText || "", actor)
        : (e.passiveText || "");
      return `
      <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:8px;">
        <img src="${e.egoImg}" style="width:28px;height:28px;border-radius:3px;border:1px solid #5a3a8a;object-fit:cover;flex-shrink:0;">
        <div>
          <div style="font-size:12px;font-weight:700;color:#c9a227;">${e.passiveName || e.egoName}</div>
          <div style="font-size:10px;color:#7a6a9a;">${e.egoName}</div>
          <div style="font-size:11px;color:#ccc;line-height:1.4;">${enrichedText || "<em style='color:#555'>No passive text.</em>"}</div>
        </div>
      </div>`;
    }).join("");
    await ChatMessage.create({
      speaker: actor ? ChatMessage.getSpeaker({ actor }) : { alias: "EGO" },
      content: `<div style="font-family:'Signika',serif;background:#0d0b15;border:1px solid #5a3a8a;border-radius:8px;padding:10px 12px;">
        <div style="font-size:11px;font-weight:900;color:#c9a227;letter-spacing:0.1em;margin-bottom:8px;border-bottom:1px solid #3a2060;padding-bottom:4px;">
          <img src="systems/sotc/assets/statuses/Limbus/E.G.O%20Passives.png" style="width:14px;height:14px;border:none;vertical-align:middle;margin-right:4px;">
          E.G.O PASSIVES${actor ? ` — ${actor.name}` : ""}
        </div>${rows}</div>`
    });
    this._hidePanel();
  },

  _getToken(actorId) {
    const p = canvas?.tokens?.placeables ?? [];
    let t = p.find(t => t.actor?.id === actorId);
    if (t) return t;
    t = p.find(t => t.document?.actorId === actorId);
    if (t) return t;
    const tokenActorId = (this.entriesByActor.get(actorId) ?? [])[0]?.tokenActorId;
    if (tokenActorId) return p.find(t => t.actor?.id === tokenActorId);
    return null;
  },

  _cleanToken(token) {
    if (!token?._egoPassiveMarkers) return;
    token._egoPassiveMarkers.forEach(m => {
      try { m.pixi?.destroy({ children: true }); m.destroy?.({ children: true }); } catch (e) {}
    });
    token._egoPassiveMarkers = [];
  },

  _removeBadge(actorId) {
    const token = this._getToken(actorId);
    if (token) this._cleanToken(token);
  },

  _renderForActor(actorId) {
    const token   = this._getToken(actorId);
    if (!token) return;
    this._cleanToken(token);
    const entries = this.entriesByActor.get(actorId) ?? [];
    if (entries.length === 0) return;

    const R     = 16;
    const badge = new PIXI.Container();

    const bg = new PIXI.Graphics();
    bg.beginFill(0x0d0b1e, 0.92);
    bg.lineStyle(1.5, 0xc9a227, 1);
    bg.drawCircle(0, 0, R);
    bg.endFill();
    badge.addChild(bg);

    const tex  = PIXI.Texture.from("systems/sotc/assets/statuses/Limbus/E.G.O%20Passives.png");
    const icon = new PIXI.Sprite(tex);
    icon.anchor.set(0.5);
    icon.width = icon.height = R * 1.4;
    badge.addChild(icon);

    const bubble = new PIXI.Graphics();
    bubble.beginFill(0x5a2090, 1);
    bubble.drawCircle(R - 4, -R + 4, 7);
    bubble.endFill();
    badge.addChild(bubble);
    const countTxt = new PIXI.Text(String(entries.length), {
      fontFamily: "Arial", fontSize: 9, fontWeight: "bold", fill: 0xffffff
    });
    countTxt.anchor.set(0.5);
    countTxt.x = R - 4; countTxt.y = -R + 4;
    badge.addChild(countTxt);

    badge.x = -R - 2;
    badge.y = token.h + R + 4;
    token.addChild(badge);
    token._egoPassiveMarkers = [badge];
  },

  _installStageListener() { _installSharedTrackerListener(); },

  _worldToScreen(wx, wy) {
    const t = canvas.stage.worldTransform;
    return { x: wx * t.a + t.tx, y: wy * t.d + t.ty };
  },
  _screenToWorld(sx, sy) {
    const t = canvas.stage.worldTransform;
    return { x: (sx - t.tx) / t.a, y: (sy - t.ty) / t.d };
  },
  _updatePanelPos() {
    if (!this._panel) return;
    const s     = this._worldToScreen(this._panelWorldX, this._panelWorldY);
    const scale = Math.max(0.1, Math.min(1, canvas.stage.worldTransform.a * 0.5));
    this._panel.style.left            = s.x + "px";
    this._panel.style.top             = s.y + "px";
    this._panel.style.transform       = `scale(${scale})`;
    this._panel.style.transformOrigin = "top left";
  },

  // Open the floating panel in place, same as the enemy reveal tracker.
  _showTooltipAt(actorId, sx, sy) { this._openPanel(actorId, sx, sy); },

  _openPanel(actorId, screenX, screenY) {
    if (this._panel && this._panelActorId === actorId) { this._hidePanel(); return; }
    this._hidePanel();
    this._panelActorId = actorId;
    const world        = this._screenToWorld(screenX + 20, screenY - 40);
    this._panelWorldX  = world.x;
    this._panelWorldY  = world.y;

    const panel = document.createElement("div");
    panel.id    = "sotc-ego-panel";
    panel.style.cssText = `
      position:fixed; z-index:25; pointer-events:all;
      min-width:260px; max-width:320px;
      background:#0d0b15ee; border:1px solid #5a3a8a;
      border-radius:8px; box-shadow:0 4px 20px #000e;
      font-family:'Signika',serif; user-select:none;
    `;

    const actor  = this._getToken(actorId)?.actor;
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:6px;padding:8px 10px;background:#2a1545;border-radius:8px 8px 0 0;cursor:grab;border-bottom:1px solid #5a3a8a;";
    header.innerHTML = `
      <img src="systems/sotc/assets/statuses/Limbus/E.G.O%20Passives.png" style="width:16px;height:16px;border:none;object-fit:contain;">
      <span style="font-size:11px;font-weight:900;color:#c9a227;letter-spacing:0.1em;flex:1;">EGO PASSIVES${actor ? ` — ${actor.name}` : ""}</span>
      <a id="sotc-ego-print" title="Post to chat" style="font-size:11px;color:#9a8aba;cursor:pointer;margin-right:4px;"><i class="fas fa-comment"></i></a>
      <a id="sotc-ego-clear" title="Clear all" style="font-size:11px;color:#a06060;cursor:pointer;margin-right:4px;"><i class="fas fa-trash"></i></a>
      <a id="sotc-ego-close" title="Close" style="font-size:13px;color:#666;cursor:pointer;">✕</a>`;
    panel.appendChild(header);

    header.addEventListener("mousedown", ev => {
      if (ev.target.closest("a")) return;
      if (ev.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      const ox   = ev.clientX - rect.left, oy = ev.clientY - rect.top;
      const onMove = e => {
        const sx = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox));
        const sy = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy));
        panel.style.left = sx + "px"; panel.style.top = sy + "px";
        const w = this._screenToWorld(sx, sy);
        this._panelWorldX = w.x; this._panelWorldY = w.y;
      };
      const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    header.querySelector("#sotc-ego-print").addEventListener("click", ev => { ev.stopPropagation(); this._printToChat(actorId); });
    header.querySelector("#sotc-ego-clear").addEventListener("click", ev => { ev.stopPropagation(); this.clearAll(actorId); });
    header.querySelector("#sotc-ego-close").addEventListener("click", ev => { ev.stopPropagation(); this._hidePanel(); });

    const body = document.createElement("div");
    body.id    = "sotc-ego-panel-body";
    body.style.cssText = "padding:8px 10px;max-height:400px;overflow-y:auto;";
    panel.appendChild(body);

    document.body.appendChild(panel);
    this._panel = panel;
    this._updatePanelPos();
    this._rebuildPanelBody(actorId);

    if (this._panelTicker) canvas?.app?.ticker?.remove(this._panelTicker);
    let lastTx = null;
    this._panelTicker = () => {
      const tx = canvas?.stage?.worldTransform?.tx;
      if (tx !== lastTx) { lastTx = tx; this._updatePanelPos(); }
    };
    canvas.app.ticker.add(this._panelTicker);
  },

  _rebuildPanelBody(actorId) {
    const body = this._panel?.querySelector("#sotc-ego-panel-body");
    if (!body) return;
    body.innerHTML = "";
    const entries = this.entriesByActor.get(actorId) ?? [];
    if (!entries.length) {
      body.innerHTML = `<div style="font-size:11px;color:#555;font-style:italic;">No active EGO passives.</div>`;
      return;
    }
    const actor = this._getToken(actorId)?.actor;
    for (const entry of entries) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:flex-start;gap:8px;margin-bottom:8px;";
      const enriched = game.sotc?.enrichModWithStatusIcons
        ? game.sotc.enrichModWithStatusIcons(entry.passiveText || "", actor)
        : (entry.passiveText || "");
      row.innerHTML = `
        <img src="${entry.egoImg}" style="width:28px;height:28px;border-radius:3px;border:1px solid #5a3a8a;object-fit:cover;flex-shrink:0;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;font-weight:700;color:#c9a227;margin-bottom:1px;">${entry.passiveName || entry.egoName}</div>
          <div style="font-size:10px;color:#7a6a9a;margin-bottom:4px;">${entry.egoName}</div>
          <div style="font-size:12px;color:#ccc;line-height:1.5;">${entry.passiveText || "<em>No passive text.</em>"}</div>
        </div>
        <a class="sotc-ego-remove" style="font-size:12px;color:#555;cursor:pointer;flex-shrink:0;padding:2px 4px;" title="Remove">✕</a>`;
      row.querySelector(".sotc-ego-remove").addEventListener("click", () => this.remove(actorId, entry.id));
      body.appendChild(row);
    }
  },

  _hidePanel() {
    if (this._panelTicker) { canvas?.app?.ticker?.remove(this._panelTicker); this._panelTicker = null; }
    this._panel?.remove();
    this._panel        = null;
    this._panelActorId = null;
  },

  refreshAll() {
    for (const [actorId] of this.entriesByActor) this._renderForActor(actorId);
    this._installStageListener();
  },

  _doLoadAndDraw() {
    // Clean stale PIXI badges first, then load and redraw — same pattern as
    // the enemy reveal tracker, so persistence survives F5/restart.
    for (const [actorId] of this.entriesByActor) {
      const token = this._getToken(actorId);
      if (token) this._cleanToken(token);
    }
    if (this._stageHandler) canvas?.stage?.off("pointerdown", this._stageHandler);
    this.entriesByActor.clear();
    this._loadAll();
    this.refreshAll();
    this._installStageListener();
  },

  init() {
    // canvasReady fires once per scene load. On a plain F5 the canvas is NOT
    // ready when ready() runs, so we need the hook. But canvasReady may have
    // already fired by the time init() is called (e.g. F5, where it fires
    // before our ready hook's setTimeout) — in that case the hook below will
    // never fire again, so we also check canvas.initialized immediately.
    Hooks.on("canvasReady", () => {
      setTimeout(() => this._doLoadAndDraw(), 300);
    });

    if (canvas?.initialized) {
      setTimeout(() => this._doLoadAndDraw(), 300);
    }

    Hooks.on("createToken", tokenDoc => {
      setTimeout(() => {
        const actorId = tokenDoc.document?.actorId ?? tokenDoc.actor?.id;
        if (actorId && this.entriesByActor.has(actorId)) this._renderForActor(actorId);
      }, 200);
    });
    Hooks.on("deleteToken", tokenDoc => {
      const actorId = tokenDoc.actor?.id;
      if (actorId) this._removeBadge(actorId);
    });
  }
};

// ── Enemy Reveal Tracker ──────────────────────────────────────────────────────

export const _enemyRevealTracker = {
  entriesByActor: new Map(),
  _panel:         null,
  _panelActorId:  null,
  _panelWorldX:   0,
  _panelWorldY:   0,
  _panelTicker:   null,
  _stageHandler:  null,

  _makeId() { return foundry.utils.randomID(8); },

  add(actorId, entry) {
    if (!this.entriesByActor.has(actorId)) this.entriesByActor.set(actorId, []);
    const arr = this.entriesByActor.get(actorId);
    if (arr.some(e => e.skillName === entry.skillName)) return;
    arr.push({ ...entry, id: this._makeId() });
    this._renderForActor(actorId);
    this._installStageListener();
    if (this._panelActorId === actorId) this._rebuildPanelBody(actorId);
    this._save(actorId);
    // Broadcast to all other clients so their badges update immediately
    game.socket.emit("system.sotc", {
      type:    "enemyRevealSync",
      actorId,
      entries: this.entriesByActor.get(actorId)
    });
    for (const token of (canvas?.tokens?.placeables ?? [])) {
      const tid = token.document?.actorId ?? token.actor?.id;
      if (tid === actorId && token.actor?.id !== actorId) this.add(token.actor.id, entry);
    }
  },

  remove(actorId, id) {
    const arr = (this.entriesByActor.get(actorId) ?? []).filter(e => e.id !== id);
    if (arr.length) this.entriesByActor.set(actorId, arr);
    else this.entriesByActor.delete(actorId);
    this._removeBadge(actorId);
    this._renderForActor(actorId);
    if (this._panelActorId === actorId) this._rebuildPanelBody(actorId);
    this._saveAll();
    game.socket.emit("system.sotc", {
      type:    "enemyRevealSync",
      actorId,
      entries: this.entriesByActor.get(actorId) ?? []
    });
  },

  clearAll(actorId) {
    this.entriesByActor.delete(actorId);
    this._removeBadge(actorId);
    this._hidePanel();
    this._saveAll();
    game.socket.emit("system.sotc", {
      type:    "enemyRevealSync",
      actorId,
      entries: []
    });
  },

  async _save(actorId) {
    if (!game.user.isGM) return;
    try {
      let data = {};
      try { data = JSON.parse(game.settings.get("sotc", "enemyRevealData") || "{}"); } catch {}
      const entries = this.entriesByActor.get(actorId) ?? [];
      if (entries.length) data[actorId] = entries;
      else delete data[actorId];
      await game.settings.set("sotc", "enemyRevealData", JSON.stringify(data));
    } catch (e) { console.warn("sotc | enemyReveal: save failed:", e); }
  },

  async _saveAll() {
    if (!game.user.isGM) return;
    const data = {};
    for (const [actorId, entries] of this.entriesByActor) {
      if (entries.length) data[actorId] = entries;
    }
    await game.settings.set("sotc", "enemyRevealData", JSON.stringify(data));
  },

  _loadAll() {
    // No GM guard — reading a world setting is safe for any connected user.
    // Writing is still GM-only (see _save / _saveAll).
    try {
      const data = JSON.parse(game.settings.get("sotc", "enemyRevealData") || "{}");
      for (const [actorId, entries] of Object.entries(data)) {
        if (entries?.length) this.entriesByActor.set(actorId, entries);
      }
    } catch (e) { console.warn("sotc | enemyReveal: load failed:", e); }
  },

  // Called on all clients when a socket sync message arrives.
  // Receives the full entries array directly from the emitting client so
  // players update immediately without waiting for a settings read.
  syncActor(actorId, entries) {
    if (entries?.length) this.entriesByActor.set(actorId, entries);
    else this.entriesByActor.delete(actorId);
    this._removeBadge(actorId);
    this._renderForActor(actorId);
    this._installStageListener();
    if (this._panelActorId === actorId) this._rebuildPanelBody(actorId);
  },

  _getToken(actorId) {
    const p = canvas?.tokens?.placeables ?? [];

    // Primary: if any stored entry has a tokenId, use it — this is the only
    // reliable key for unlinked tokens whose token.actor.id differs from the
    // world actor ID we stored as the map key.
    const entries = this.entriesByActor.get(actorId) ?? [];
    const tokenId = entries[0]?.tokenId;
    if (tokenId) {
      const byId = p.find(t => t.id === tokenId);
      if (byId) return byId;
    }

    // Fallback for linked tokens where actor.id === world actor id
    return p.find(t => t.actor?.id === actorId)
        ?? p.find(t => t.document?.actorId === actorId);
  },

  _cleanToken(token) {
    if (!token?._enemyRevealMarkers) return;
    token._enemyRevealMarkers.forEach(m => { try { m.destroy({ children: true }); } catch (e) {} });
    token._enemyRevealMarkers = [];
  },

  _removeBadge(actorId) {
    const token = this._getToken(actorId);
    if (token) this._cleanToken(token);
  },

  _renderForActor(actorId) {
    const token = this._getToken(actorId);
    if (!token) return;
    this._cleanToken(token);
    const entries = this.entriesByActor.get(actorId) ?? [];
    if (entries.length === 0) return;

    const R     = 14;
    const badge = new PIXI.Container();
    const bg    = new PIXI.Graphics();
    bg.beginFill(0x1a0a0a, 0.92);
    bg.lineStyle(1.5, 0xe05050, 1);
    bg.drawCircle(0, 0, R);
    bg.endFill();
    badge.addChild(bg);

    const tex  = PIXI.Texture.from("systems/sotc/assets/statuses/Limbus/Taunt.png");
    const icon = new PIXI.Sprite(tex);
    icon.anchor.set(0.5);
    icon.width = icon.height = R * 1.4;
    badge.addChild(icon);

    const bubble = new PIXI.Graphics();
    bubble.beginFill(0x902020, 1);
    bubble.drawCircle(R - 4, -R + 4, 7);
    bubble.endFill();
    badge.addChild(bubble);
    const countTxt = new PIXI.Text(String(entries.length), {
      fontFamily: "Arial", fontSize: 9, fontWeight: "bold", fill: 0xffffff
    });
    countTxt.anchor.set(0.5);
    countTxt.x = R - 4; countTxt.y = -R + 4;
    badge.addChild(countTxt);

    badge.x = token.w + R + 2;
    badge.y = token.h + R + 4;
    token.addChild(badge);
    token._enemyRevealMarkers = [badge];
  },

  _installStageListener() { _installSharedTrackerListener(); },

  _worldToScreen(wx, wy) {
    const t = canvas.stage.worldTransform;
    return { x: wx * t.a + t.tx, y: wy * t.d + t.ty };
  },
  _screenToWorld(sx, sy) {
    const t = canvas.stage.worldTransform;
    return { x: (sx - t.tx) / t.a, y: (sy - t.ty) / t.d };
  },
  _updatePanelPos() {
    if (!this._panel) return;
    const s     = this._worldToScreen(this._panelWorldX, this._panelWorldY);
    const scale = Math.max(0.1, Math.min(1, canvas.stage.worldTransform.a * 0.5));
    this._panel.style.left            = s.x + "px";
    this._panel.style.top             = s.y + "px";
    this._panel.style.transform       = `scale(${scale})`;
    this._panel.style.transformOrigin = "top left";
  },

  _showPanel(actorId, screenX, screenY) {
    if (this._panel && this._panelActorId === actorId) { this._hidePanel(); return; }
    this._hidePanel();
    this._panelActorId = actorId;
    const world        = this._screenToWorld(screenX + 20, screenY - 40);
    this._panelWorldX  = world.x;
    this._panelWorldY  = world.y;

    const panel = document.createElement("div");
    panel.id    = "sotc-enemy-panel";
    panel.style.cssText = `
      position:fixed; z-index:25; pointer-events:all;
      min-width:260px; max-width:320px;
      background:#100808ee; border:1px solid #7a2a2a;
      border-radius:8px; box-shadow:0 4px 20px #000e;
      font-family:'Signika',serif; user-select:none;
    `;

    const actor  = this._getToken(actorId)?.actor;
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:6px;padding:8px 10px;background:#2a0f0f;border-radius:8px 8px 0 0;cursor:grab;border-bottom:1px solid #5a2020;";
    header.innerHTML = `
      <img src="systems/sotc/assets/statuses/Limbus/Taunt.png" style="width:16px;height:16px;border:none;object-fit:contain;">
      <span style="font-size:11px;font-weight:900;color:#e05050;letter-spacing:0.1em;flex:1;">REVEALED — ${actor?.name ?? "Enemy"}</span>
      <a id="enemy-clear-all" title="Clear all" style="font-size:11px;color:#c06060;cursor:pointer;margin-right:4px;"><i class="fas fa-trash"></i></a>
      <a id="enemy-close" title="Close" style="font-size:13px;color:#666;cursor:pointer;">✕</a>`;
    panel.appendChild(header);

    header.addEventListener("mousedown", ev => {
      if (ev.target.closest("a")) return;
      if (ev.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      const ox   = ev.clientX - rect.left, oy = ev.clientY - rect.top;
      const onMove = e => {
        const sx = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox));
        const sy = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy));
        panel.style.left = sx + "px"; panel.style.top = sy + "px";
        const w = this._screenToWorld(sx, sy);
        this._panelWorldX = w.x; this._panelWorldY = w.y;
      };
      const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    header.querySelector("#enemy-clear-all").addEventListener("click", ev => { ev.stopPropagation(); this.clearAll(actorId); });
    header.querySelector("#enemy-close").addEventListener("click",     ev => { ev.stopPropagation(); this._hidePanel(); });

    const body    = document.createElement("div");
    body.id       = "sotc-enemy-panel-body";
    body.style.cssText = "padding:8px 10px;max-height:400px;overflow-y:auto;";
    panel.appendChild(body);

    document.body.appendChild(panel);
    this._panel = panel;
    this._updatePanelPos();
    this._rebuildPanelBody(actorId);

    if (this._panelTicker) canvas.app.ticker.remove(this._panelTicker);
    let lastTx = null;
    this._panelTicker = () => {
      const tx = canvas?.stage?.worldTransform?.tx;
      if (tx !== lastTx) { lastTx = tx; this._updatePanelPos(); }
    };
    canvas.app.ticker.add(this._panelTicker);
  },

  _rebuildPanelBody(actorId) {
    const body = this._panel?.querySelector("#sotc-enemy-panel-body");
    if (!body) return;
    body.innerHTML = "";
    const entries = this.entriesByActor.get(actorId) ?? [];
    if (!entries.length) {
      body.innerHTML = `<div style="font-size:11px;color:#555;font-style:italic;text-align:center;padding:8px;">Nothing revealed yet.</div>`;
      return;
    }

    const enrich   = game.sotc?.enrichModWithStatusIcons;
    const entryActor = game.actors.get(actorId)
      ?? (canvas?.tokens?.placeables ?? []).find(t => t.actor?.id === actorId)?.actor;

    const categories = [
      { key: "skill",   label: "Attacks",     color: "#e07070", entries: entries.filter(e => e.type === "skill")   },
      { key: "passive", label: "Passives",    color: "#c9a227", entries: entries.filter(e => e.type === "passive") },
      { key: "ego",     label: "EGO Passives", color: "#9a7abf", entries: entries.filter(e => e.type === "ego")    },
    ];

    for (const cat of categories) {
      if (!cat.entries.length) continue;
      const catHeader        = document.createElement("div");
      catHeader.style.cssText = `font-size:10px;font-weight:900;color:${cat.color};letter-spacing:0.1em;padding:6px 0 3px;border-bottom:1px solid ${cat.color}44;margin-bottom:4px;`;
      catHeader.textContent  = cat.label;
      body.appendChild(catHeader);

      for (const entry of cat.entries) {
        const row          = document.createElement("div");
        row.style.cssText  = "display:flex;align-items:flex-start;gap:8px;padding:5px 0;border-bottom:1px solid #1a0808;";
        row.innerHTML      = `
          <img src="${entry.skillImg || 'icons/svg/mystery-man.svg'}" style="width:28px;height:28px;border-radius:3px;border:1px solid #5a2020;object-fit:cover;flex-shrink:0;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;font-weight:700;color:#e8d9a0;margin-bottom:2px;" data-name></div>
            <div style="font-size:11px;color:#bbb;line-height:1.4;" data-desc></div>
          </div>
          <a class="enemy-remove" style="font-size:12px;color:#555;cursor:pointer;flex-shrink:0;padding:2px 4px;" title="Remove">✕</a>`;
        row.querySelector("[data-name]").textContent = entry.skillName;
        const descEl = row.querySelector("[data-desc]");
        if (entry.description) {
          let parsed = null;
          try { parsed = JSON.parse(entry.description); } catch (e) {}
          if (parsed?.diceData !== undefined) {
            let html = "";
            const costParts = [];
            const lc = (parsed.lightCost ?? "0").toString().trim();
            costParts.push(`<img src="systems/sotc/assets/sheets/LightIcon.webp" style="width:12px;height:12px;border:none;vertical-align:middle;margin-right:1px;"><strong style="color:#c9a227">${lc || "0"}</strong>`);
            const ec = (parsed.emotionCost ?? "0").toString().trim();
            if (ec && ec !== "0") costParts.push(`<img src="systems/sotc/assets/sheets/skills/SkillEmotionIcon.png" style="width:12px;height:12px;border:none;vertical-align:middle;margin-right:1px;"><strong style="color:#a070d0">${ec}</strong>`);
            const wt = Number(parsed.weight ?? 0);
            if (wt > 1) costParts.push(`<img src="systems/sotc/assets/sheets/skills/SkillMass.png" style="width:12px;height:12px;border:none;vertical-align:middle;margin-right:1px;"><strong style="color:#e07070">Weight ${wt}</strong>`);
            if (costParts.length) html += `<div style="font-size:11px;margin-bottom:5px;display:flex;gap:8px;align-items:center;">${costParts.join("")}</div>`;
            if (parsed.diceData?.length) {
              for (const d of parsed.diceData) {
                const imgTag = d.img ? `<img src="${d.img}" style="width:18px;height:18px;border:none;vertical-align:middle;margin-right:3px;">` : "";
                let dieHtml  = `<div style="display:flex;align-items:center;gap:4px;margin-bottom:3px;">${imgTag}<strong style="color:#e8d9a0;font-size:12px;">${d.result}</strong></div>`;
                if (d.mods?.length) {
                  dieHtml += d.mods.map(mod => {
                    const enriched = enrich ? enrich(mod.trim(), entryActor) : mod.trim();
                    return `<div style="margin-left:22px;margin-bottom:2px;font-size:11px;color:#ccc;">${enriched}</div>`;
                  }).join("");
                }
                html += `<div style="margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #2a1010;">${dieHtml}</div>`;
              }
            }
            if (parsed.description?.trim()) html += `<div style="font-size:11px;color:#aaa;margin-top:4px;font-style:italic;">${parsed.description}</div>`;
            descEl.innerHTML = html || "<em style='color:#555'>No description.</em>";
          } else {
            const lines = entry.description.split(" | ").filter(l => l.trim());
            if (lines.length > 1) {
              descEl.innerHTML = lines.map(l => {
                const enriched = enrich ? enrich(l.trim(), entryActor) : l.trim();
                return `<div style="margin-bottom:3px;">${enriched}</div>`;
              }).join("");
            } else {
              descEl.innerHTML = enrich ? enrich(entry.description, entryActor) : entry.description;
            }
          }
        } else {
          descEl.innerHTML = "<em style='color:#555'>No description.</em>";
        }
        row.querySelector(".enemy-remove").addEventListener("click", ev => { ev.stopPropagation(); this.remove(actorId, entry.id); });
        body.appendChild(row);
      }
    }

    body.querySelectorAll(".apply-status-from-chat").forEach(btn => {
      btn.addEventListener("click", ev => _applyStatusButton(ev, actorId));
    });
  },

  _hidePanel() {
    if (this._panelTicker) { canvas?.app?.ticker?.remove(this._panelTicker); this._panelTicker = null; }
    this._panel?.remove();
    this._panel        = null;
    this._panelActorId = null;
  },

  refreshAll() {
    for (const [actorId] of this.entriesByActor) this._renderForActor(actorId);
    this._installStageListener();
  },

  _doLoadAndDraw() {
    // Clean stale PIXI badges first, then load and redraw.
    for (const [actorId] of this.entriesByActor) {
      const token = this._getToken(actorId);
      if (token) this._cleanToken(token);
    }
    // Clear in-memory data before reloading so we don't double-stack entries
    this.entriesByActor.clear();
    if (this._stageHandler) canvas?.stage?.off("pointerdown", this._stageHandler);
    this._loadAll();
    this.refreshAll();
    this._installStageListener();
  },

  init() {
    // canvasReady fires once per scene load. On a plain F5 the canvas is NOT
    // ready when ready() runs, so we need the hook. But on a scene change the
    // canvas IS ready before init() is called via the ready hook's setTimeout,
    // which means canvasReady has already fired and will never fire again for
    // the current session — so we also check immediately after a short delay.
    Hooks.on("canvasReady", () => {
      // Slight delay so all tokens are fully placed on the canvas before we
      // try to find them and draw badges.
      setTimeout(() => this._doLoadAndDraw(), 300);
    });

    // Fallback: if the canvas is already initialised by the time init() is called
    // (e.g. F5 where canvasReady fires before our ready hook's setTimeout),
    // run the load+draw now instead of waiting for a hook that won't fire again.
    // canvas.initialized is the reliable Foundry flag set after canvasReady.
    if (canvas?.initialized) {
      setTimeout(() => this._doLoadAndDraw(), 300);
    }

    Hooks.on("createToken", tokenDoc => {
      setTimeout(() => {
        const actorId = tokenDoc.document?.actorId ?? tokenDoc.actor?.id;
        if (actorId && this.entriesByActor.has(actorId)) this._renderForActor(actorId);
      }, 200);
    });
    Hooks.on("deleteToken", tokenDoc => {
      const actorId = tokenDoc.actor?.id;
      if (actorId) this._removeBadge(actorId);
    });
  }
};

// ── Shared canvas stage listener ──────────────────────────────────────────────
let _sharedTrackerHandler = null;
function _installSharedTrackerListener() {
  if (_sharedTrackerHandler) canvas.stage.off("pointerdown", _sharedTrackerHandler);
  _sharedTrackerHandler = ev => {
    const pos = ev.global;
    for (const [actorId] of _egoPassiveTracker.entriesByActor) {
      const token = _egoPassiveTracker._getToken(actorId);
      if (!token?._egoPassiveMarkers?.length) continue;
      for (const entry of token._egoPassiveMarkers) {
        const marker = entry.pixi ?? entry;
        try {
          const b = marker.getBounds();
          if (b.width < 1) continue;
          if (pos.x >= b.x && pos.x <= b.x + b.width &&
              pos.y >= b.y && pos.y <= b.y + b.height) {
            _egoPassiveTracker._showTooltipAt(actorId, b.x + b.width, b.y);
            return;
          }
        } catch (e) {}
      }
    }
    for (const [actorId] of _enemyRevealTracker.entriesByActor) {
      const token = _enemyRevealTracker._getToken(actorId);
      if (!token?._enemyRevealMarkers?.length) continue;
      for (const marker of token._enemyRevealMarkers) {
        try {
          const b = marker.getBounds();
          if (b.width < 1) continue;
          if (pos.x >= b.x && pos.x <= b.x + b.width &&
              pos.y >= b.y && pos.y <= b.y + b.height) {
            _enemyRevealTracker._showPanel(actorId, b.x + b.width, b.y);
            return;
          }
        } catch (e) {}
      }
    }
  };
  canvas.stage.on("pointerdown", _sharedTrackerHandler);
}

// ── HOOKS ─────────────────────────────────────────────────────────────────────
// Tracker init is called directly from sotc.js's ready hook after game.sotc
// is created, so the trackers are available on game.sotc before init() runs.
// The _oldMessageIds set is also assigned there for the same reason.

// Drag-sort + active EGO styles
Hooks.once("ready", () => {
  const style = document.createElement("style");
  style.textContent = `
    .sotc-drag-ghost  { opacity: 0.35; }
    .sotc-drag-over   { outline: 2px dashed #c9a227; outline-offset: 2px; }
    .set-active-ego   { transition: color 0.15s; }
    .set-active-ego:hover { color: #f9c74f !important; }
    .ego_container.ego-active-highlight .skill_card { box-shadow: 0 0 8px 2px #c9a22788; }
    .ego_drag_handle, .skill_drag_handle { cursor: grab; }
    .ego_drag_handle:active, .skill_drag_handle:active { cursor: grabbing; }
    #sotc-enemy-panel .reroll-die,
    #sotc-enemy-panel .resolve-die,
    #sotc-enemy-panel a { color: #c9a227 !important; }
    #sotc-enemy-panel .reroll-die i,
    #sotc-enemy-panel .resolve-die i { color: #c9a227 !important; }
    .sotc-ego-passive-tooltip {
      position: fixed; z-index: 70; pointer-events: all;
      background: #0d0b15ee; border: 1px solid #5a3a8a;
      border-radius: 8px; padding: 10px 12px;
      font-family: 'Signika', serif; max-width: 260px; min-width: 180px;
      box-shadow: 0 4px 20px #000e;
    }
  `;
  document.head.appendChild(style);
});

Hooks.on("renderDialog", (dialog, html) => {
  const nameInput = html.find('input[name="name"]')[0];
  if (!nameInput) return;
  if (!html.find('select[name="type"]').length) return;
  requestAnimationFrame(() => { nameInput.select(); nameInput.focus(); });
});

Hooks.on("createActor", async (actor, options, userId) => {
  const pack = game.packs.get("sotc.default-statuses");
  if (!pack) { console.error("SotC | Default statuses compendium not found."); return; }

  const statuses = await pack.getDocuments();
  const items    = statuses.map(s => s.toObject());

  for (const item of items) {
    if (!item.system) continue;
    const nameLower = (item.name ?? "").toLowerCase();

    if (nameLower === "sinking") {
      const sce = item.system.scene_end_effect;
      if (sce && sce.min_resource_limit == null) item.system.scene_end_effect = { ...sce, min_resource_limit: 1 };
      const raw_pa = item.system.post_actives;
      if (raw_pa) {
        const pa_arr = Array.isArray(raw_pa) ? raw_pa : Object.values(raw_pa);
        item.system.post_actives = pa_arr.map(pa => {
          if (pa.operator === "sinking_deluge") return pa;
          if (pa.min_resource_limit == null) return { ...pa, min_resource_limit: 1 };
          return pa;
        });
      }
    }

    if (nameLower === "thorns") {
      if (!item.system.special_trigger) item.system.special_trigger = "on_receive_damage";
      if (!item.system.condition)       item.system.condition       = "special";
    }
  }

  await actor.createEmbeddedDocuments("Item", items.filter(item =>
    !actor.items.some(ai => ai.name === item.name)
  ));
});

// ── renderChatMessage ─────────────────────────────────────────────────────────
Hooks.on("renderChatMessage", (message, html) => {

  // ── Enemy reveal tracker — auto-add enemy skills/passives ──────────────────
  if (game.user.isGM && game.settings.get("sotc", "enemyRevealTrackerEnabled")) {
    if (_enemyRevealTracker._oldMessageIds && !_enemyRevealTracker._oldMessageIds.has(message.id)) {
    const speakerActorId = message.speaker?.actor;
    if (speakerActorId) {
      const actor = game.actors.get(speakerActorId)
        ?? (canvas?.tokens?.placeables ?? []).find(t => t.actor?.id === speakerActorId)?.actor;
      if (actor && actor.system?.initiative_type !== "player") {
        const tokenDoc   = (canvas?.tokens?.placeables ?? []).find(t => t.actor?.id === speakerActorId);
        const baseActorId = tokenDoc?.document?.actorId ?? speakerActorId;
        const passiveCard = html.find(".sotc-passive-card")[0];

        if (passiveCard) {
          const passiveName    = passiveCard.querySelector("h3")?.textContent?.trim() ?? "Unknown Passive";
          const passiveDetails = passiveCard.querySelector(".sotc-passive-details")?.textContent?.trim() ?? "";
          const isEgoPassive   = message.content?.includes("sotc-passive-card") &&
            actor.items.some(i => i.type === "ego" && i.system.passive_name === passiveName);
          const tmpDiv         = document.createElement("div");
          tmpDiv.innerHTML     = passiveDetails;
          _enemyRevealTracker.add(baseActorId, {
            skillName:   passiveName,
            skillImg:    actor.img ?? "icons/svg/mystery-man.svg",
            description: tmpDiv.textContent?.trim() ?? "",
            type:        isEgoPassive ? "ego" : "passive",
            tokenId:     tokenDoc?.id ?? null
          });
        } else {
          const flavorEl   = document.createElement("div");
          flavorEl.innerHTML = message.flavor ?? "";
          const skillName  = flavorEl.querySelector("h3")?.textContent?.trim() ?? "";
          if (skillName) {
            // For unlinked tokens, actor is the synthetic actor whose items
            // may not be fully populated. Fall back to the world actor (same
            // actorId) for item lookup so the base formula is always found.
            const worldActor = game.actors.get(speakerActorId)
              ?? game.actors.get(tokenDoc?.document?.actorId)
              ?? actor;
            const skillItem = worldActor.items.find(i =>
              (i.type === "skill" || i.type === "ego") && i.name === skillName
            ) ?? actor.items.find(i =>
              (i.type === "skill" || i.type === "ego") && i.name === skillName
            );

            let lightCost = "0";
            flavorEl.querySelectorAll("p").forEach(p => {
              if (p.textContent.includes("Light Cost:")) lightCost = p.textContent.replace("Light Cost:", "").trim();
            });

            // Build diceData preferring the skill item's stored formula so we
            // always show the base formula (e.g. "1d6+5"), never the rolled
            // result string (e.g. "1d6+5+4 = 12") that appears in roll messages.
            const diceData = [];
            if (skillItem) {
              const rawDie = skillItem.system.dice?.die;
              const dieArr = rawDie ? (Array.isArray(rawDie) ? rawDie : Object.values(rawDie)) : [];
              dieArr.forEach(die => {
                const m      = die.mods ?? {};
                const modArr = Array.isArray(m) ? m : Object.values(m);
                const imgSrc = `systems/sotc/assets/dice types/${die.type}.png`;
                diceData.push({
                  dieType: die.type,
                  result:  die.formula ?? "?",   // base formula only, no roll result
                  img:     imgSrc,
                  mods:    modArr.filter(s => s?.trim())
                });
              });
            } else {
              // Fallback: parse from the rendered HTML when no skill item found.
              // Strip roll result suffix (everything from the last "=" onward).
              flavorEl.querySelectorAll("span").forEach(span => {
                if (!span.className?.includes("die-color-")) return;
                const img     = span.querySelector("img");
                const dieType = img?.alt ?? img?.title ?? span.className.replace(/.*die-color-(\w+).*/, "$1") ?? "?";
                const rawText = span.querySelector("strong")?.textContent?.trim() ?? "?";
                // Keep only the part before " = " to strip the rolled total
                const result  = rawText.split(/\s*=\s*/)[0].trim();
                diceData.push({ dieType, result, img: img?.src ?? "", mods: [] });
              });

              flavorEl.querySelectorAll("a, button, .reroll-die, .resolve-die, .apply-status-from-chat").forEach(el => el.remove());

              diceData.forEach((die, idx) => {
                const span = [...flavorEl.querySelectorAll("span")].filter(s => s.className?.includes("die-color-"))[idx];
                const mods = [];
                if (span) span.querySelectorAll("em").forEach(em => { const t = em.textContent.trim(); if (t) mods.push(t); });
                die.mods = mods;
              });
            }

            const allModLines = [];
            flavorEl.querySelectorAll("em").forEach(em => {
              const t = em.textContent.trim();
              if (t && !diceData.some(d => d.mods?.includes(t))) allModLines.push(t);
            });

            if (skillItem?.system.light_cost != null) lightCost = String(skillItem.system.light_cost);
            let emotionCost = "";
            if (skillItem?.system.emotion_cost) {
              emotionCost = String(skillItem.system.emotion_cost);
            } else {
              flavorEl.querySelectorAll("p").forEach(p => {
                if (p.textContent.includes("Emotion Cost:")) emotionCost = p.textContent.replace(/.*Emotion Cost:\s*/, "").trim();
              });
            }

            // Skill-level module text (e.g. "[On Use] ...", "[After Use] ...")
            // Read directly from the item when available — more reliable than
            // parsing the rendered HTML which only contains die-level mods.
            let skillModText = "";
            if (skillItem) {
              const rawMods = skillItem.system.skill_modules?.mods;
              if (rawMods) {
                const modsArr = Array.isArray(rawMods)
                  ? rawMods
                  : (typeof rawMods === "string"
                      ? rawMods.split("\n").map(s => s.trim()).filter(Boolean)
                      : Object.values(rawMods));
                skillModText = modsArr.filter(m => m?.trim()).join(" | ");
              }
            }
            // Fall back to whatever the HTML gave us if item wasn't found
            if (!skillModText) skillModText = allModLines.join(" | ");

            const attackWeight = skillItem?.system.weight ?? 0;

            const structuredDesc = JSON.stringify({
              lightCost, emotionCost,
              weight: attackWeight,
              diceData,
              description: skillModText
            });

            _enemyRevealTracker.add(baseActorId, {
              skillName:   skillName,
              skillImg:    skillItem?.img ?? actor.img ?? "icons/svg/mystery-man.svg",
              description: structuredDesc,
              type:        "skill",
              tokenId:     tokenDoc?.id ?? null
            });
          }
        }
      }
    }
    } // end if (_oldMessageIds)
  }

  // ── EGO passive tracker — runs on ALL clients for player EGO skills ─────────
  // The enemy reveal block above is GM-only. This block runs for everyone so
  // every client calls _egoPassiveTracker.add(), which emits the socket msg
  // and causes every other client to update their badge immediately.
  if (game.settings.get("sotc", "egoPassiveTrackerEnabled")) {
    if (_enemyRevealTracker._oldMessageIds && !_enemyRevealTracker._oldMessageIds.has(message.id)) {
      const speakerActorId = message.speaker?.actor;
      if (speakerActorId) {
        const actor = game.actors.get(speakerActorId)
          ?? (canvas?.tokens?.placeables ?? []).find(t => t.actor?.id === speakerActorId)?.actor;

        // Only track player actors
        if (actor && actor.system?.initiative_type === "player") {
          const flavorEl = document.createElement("div");
          flavorEl.innerHTML = message.flavor ?? "";
          const skillName = flavorEl.querySelector("h3")?.textContent?.trim() ?? "";
          if (skillName) {
            const egoItem = actor.items.find(i => i.type === "ego" && i.name === skillName);
            if (egoItem) {
              const passiveName = egoItem.system.passive_name?.trim() ?? "";
              const passiveText = egoItem.system.passive?.trim() ?? "";
              if (passiveName || passiveText) {
                game.sotc?.egoPassiveTracker?.add(actor.id, {
                  egoId:       egoItem.id,
                  egoName:     egoItem.name,
                  egoImg:      egoItem.img,
                  passiveName: passiveName || egoItem.name,
                  passiveText: passiveText,
                  tokenActorId: actor.id
                });
              }
            }
          }
        }
      }
    }
  }

  // ── Clash group card — collapse toggle ─────────────────────────────────────
  const toggle = html.find(".sotc-clash-toggle")[0];
  if (toggle) {
    const rows = html.find(".sotc-clash-rows")[0];
    const chev = html.find(".sotc-clash-chevron")[0];
    if (rows?.dataset?.collapsed === "true") {
      rows.style.display = "none";
      if (chev) chev.style.transform = "rotate(-90deg)";
    }
    toggle.addEventListener("click", () => {
      const collapsed = rows.style.display === "none";
      rows.style.display = collapsed ? "" : "none";
      if (chev) chev.style.transform = collapsed ? "" : "rotate(-90deg)";
    });
  }

  // ── Initiative group card — collapse toggle ────────────────────────────────
  const initToggle = html.find(".sotc-init-toggle")[0];
  if (initToggle) {
    const initRows = html.find(".sotc-init-rows")[0];
    const initChev = html.find(".sotc-init-chevron")[0];
    if (initRows?.dataset?.collapsed === "true") {
      initRows.style.display = "none";
      if (initChev) initChev.style.transform = "rotate(-90deg)";
    }
    initToggle.addEventListener("click", () => {
      const collapsed = initRows.style.display === "none";
      initRows.style.display = collapsed ? "" : "none";
      if (initChev) initChev.style.transform = collapsed ? "" : "rotate(-90deg)";
    });
  }

  // ── Safeguard yes/no ───────────────────────────────────────────────────────
  html.find(".sotc-safeguard-yes").on("click", async ev => {
    ev.preventDefault();
    const btn    = ev.currentTarget;
    const actor  = game.actors.get(btn.dataset.actorId);
    if (!actor) return;

    // Spend 1 Safeguard stack
    const safeguard = actor.items.get(btn.dataset.safeguardId);
    if (safeguard) {
      await safeguard.update({ "system.count": Math.max(0, Number(btn.dataset.sgCount) - 1) });
    }

    // Remove the stacks that were just added — nullify the trigger delta.
    // We read the live count from the actor (not the stale dataset value) so
    // concurrent updates don't cause over- or under-correction.
    const statusItem  = actor.items.get(btn.dataset.statusId);
    const stacksDelta = Number(btn.dataset.statusDelta ?? 1); // how many were added
    if (statusItem) {
      const liveCount = Number(statusItem.system?.count ?? 0);
      const newCount  = Math.max(0, liveCount - stacksDelta);
      if (newCount === 0) {
        await statusItem.delete();
      } else {
        await statusItem.update({ "system.count": newCount });
      }
    }

    try { await message.delete(); } catch (e) {}
  });

  html.find(".sotc-safeguard-no").on("click", async ev => {
    ev.preventDefault();
    try { await message.delete(); } catch (e) {}
  });

  // ── Reroll die ─────────────────────────────────────────────────────────────
  html.find(".reroll-die").on("click", async ev => {
    ev.preventDefault();
    const btn        = ev.currentTarget;
    const item_name  = btn.dataset.itemname || "Unknown Item";
    const formula    = btn.dataset.formula;
    const mod        = btn.dataset.mod;
    const status_mod = btn.dataset.statmod;
    let   total      = formula;
    if (mod       !== 0) total = `${total}+${mod}`;
    if (status_mod !== 0) total = `${total}+${status_mod}`;
    const type       = btn.dataset.type;
    const colorClass = btn.dataset.color;
    let   modules;
    try { modules = JSON.parse(btn.dataset.modules || "[]"); if (!Array.isArray(modules)) modules = []; }
    catch { modules = []; }

    try {
      const roll       = await (new Roll(total)).roll({ async: true });
      const icon       = `systems/sotc/assets/dice types/${type}.png`;
      const moduleLine = modules.length
        ? `<div style="margin-top:4px;font-size:12px;"><em>${
            modules.map(m => `<div style="margin-left:5px;margin-bottom:2px;">• ${enrichModWithStatusIcons(m, game.actors.get(message.speaker?.actor))}</div>`).join("")
          }</em></div>`
        : "";

      const payload = {
        dieType:     type,
        total:       roll.total,
        itemName:    item_name,
        formula,
        isOffensive: ["slash","pierce","blunt","counter-slash","counter-pierce","counter-blunt"].includes(type),
        isDefensive: ["block","evade","counter-block","counter-evade"].includes(type),
        actorId:     message.speaker?.actor ?? ChatMessage.getSpeaker()?.actor ?? null
      };

      const messageContent = `
        <div class="skill-die-roll">
          <h3>${item_name} - Reroll ${type}</h3>
          <div style="margin-left:5px;margin-bottom:5px;">
            <span class="${colorClass}" style="margin-left:5px;vertical-align:middle;font-size:16px;">
              <div style="display:flex;gap:4px;">
                <img src="${icon}" alt="${type}" style="height:30px;width:30px;vertical-align:middle;border:none;">
                <strong style="text-shadow:black 0.5px 0.5px;margin-top:4px;">${total} = ${roll.total}</strong>
                <a class="reroll-die"
                  data-formula="${formula}" data-type="${type}" data-mod="${mod}"
                  data-statmod="${status_mod}" data-color="${colorClass}"
                  data-modules='${JSON.stringify(modules)}' data-itemname="${item_name}"
                  title="Reroll die!" style="width:16px;height:16px;color:black;margin-top:4px;margin-left:8px;">
                  <i class="fas fa-rotate-left"></i>
                </a>
                <a class="resolve-die" title="Apply Die!"
                  data-payload='${JSON.stringify(payload)}'
                  style="width:16px;height:16px;color:black;margin-left:8px;margin-top:4px;">
                  <i class="fas fa-bolt"></i>
                </a>
                <a class="send-to-wizard" title="Send to open Damage Wizard as opposing die"
                  data-payload='${JSON.stringify(payload)}'
                  style="width:16px;height:16px;color:black;margin-left:8px;margin-top:4px;">
                  <i class="fas fa-crosshairs"></i>
                </a>
              </div>
            </span>
            ${moduleLine}
          </div>
        </div>`;

      await roll.toMessage({
        speaker: ChatMessage.getSpeaker(),
        flavor:  messageContent,
        sound:   CONFIG.sounds.dice
      });
    } catch (err) {
      console.error("Reroll failed:", err);
      ui.notifications.error("Could not reroll... :(");
    }
  });

  // ── Resolve die ────────────────────────────────────────────────────────────
  html.find(".resolve-die").on("click", ev => {
    const payload = JSON.parse(ev.currentTarget.dataset.payload);
    payload.sourceMessageId = message.id;
    openDamageWizard(payload);
  });

  // ── Send die to open Damage Wizard as the opposing die ──────────────────────
  // Lets the user open the wizard for one die (e.g. an attacker's offensive
  // die), then click this button on a different chat die (e.g. a defender's
  // block/evade roll) to fill in "Opposing Die Type" and "Opposing Die Roll"
  // automatically — detecting the die type and using its rolled total.
  html.find(".send-to-wizard").on("click", ev => {
    ev.preventDefault();
    const payload = JSON.parse(ev.currentTarget.dataset.payload);

    const wizard = document.querySelector(".sotc_damage_wizard");
    if (!wizard) {
      return ui.notifications.warn("Open the Damage Wizard first, then click this button to fill in the opposing die.");
    }

    const dieType = normaliseType(payload.dieType);
    const dieBtn  = wizard.querySelector(`.sotc-die-btn[data-value="${dieType}"]`);
    if (dieBtn) {
      dieBtn.click(); // reuses the wizard's own onclick to update styling + hidden input
    } else {
      ui.notifications.warn(`"${dieType}" isn't a valid opposing die type.`);
      return;
    }

    const input = wizard.querySelector('input[name="defender_die"]');
    if (input) {
      input.value = payload.total;
      input.dispatchEvent(new Event("input",  { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    ui.notifications.info(`Set opposing die to ${dieType} (${payload.total}).`);
  });

  // ── Undo damage ────────────────────────────────────────────────────────────
  html.find(".sotc-undo-damage").on("click", async ev => {
    ev.preventDefault();
    const btn = ev.currentTarget;
    if (btn.dataset.undone === "1") return;
    btn.dataset.undone       = "1";
    btn.style.opacity        = "0.4";
    btn.style.pointerEvents  = "none";
    btn.innerHTML            = `<i class="fas fa-check"></i> Undone`;

    let snapshot;
    try { snapshot = JSON.parse(btn.dataset.snapshot); }
    catch (e) { return ui.notifications.error("Undo failed: could not read snapshot."); }

    const restoreActor = async (snap) => {
      if (!snap) return;
      const actor = (snap.tokenId ? canvas.tokens?.get(snap.tokenId)?.actor : null)
                 ?? game.actors.get(snap.actorId);
      if (!actor) return;
      await game.sotc.updateActor(actor, {
        "system.health.value":  snap.hp,
        "system.stagger.value": snap.stagger,
      });
    };

    await restoreActor(snapshot.target);
    await restoreActor(snapshot.attacker);
    ui.notifications.info("Damage undone.");
  });

  // ── Apply status from chat mod line [+] button ────────────────────────────
  html.find(".apply-status-from-chat").on("click", async ev => {
    ev.preventDefault();
    const statusName    = ev.currentTarget.dataset.statusName;
    const rawCount      = ev.currentTarget.dataset.statusCount;
    const speakerActorId = message.speaker?.actor;
    const speakerActor  = speakerActorId ? game.actors.get(speakerActorId) : null;
    const sourceStatus  =
      speakerActor?.items.find(i => i.type === "status" && i.name.toLowerCase() === statusName) ??
      game.items.find(i => i.type === "status" && i.name.toLowerCase() === statusName);

    if (!sourceStatus)
      return ui.notifications.warn(`No status item found for "${statusName}". Make sure it exists as a world item or on the actor.`);

    const targets = [...game.user.targets];
    if (!targets.length)
      return ui.notifications.warn("No target selected. Right-click a token and target it first.");

    let stacksToAdd;
    if (rawCount && Number(rawCount) > 0) {
      stacksToAdd = Number(rawCount);
    } else {
      stacksToAdd = await new Promise(resolve => {
        new Dialog({
          title:   `Apply ${sourceStatus.name}`,
          content: `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
            <label style="flex-shrink:0;">Stacks to apply:</label>
            <input id="sotc-stack-input" type="number" min="1" value="1" style="width:60px;" autofocus />
          </div>`,
          buttons: {
            apply:  { icon: '<i class="fas fa-check"></i>',  label: "Apply",  callback: html => { const val = Number(html.find("#sotc-stack-input").val()); resolve(val > 0 ? val : 1); } },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel", callback: () => resolve(null) }
          },
          default: "apply"
        }).render({ force: true });
      });
    }
    if (!stacksToAdd) return;

    for (const target of targets) {
      const targetActor = target.actor;
      if (!targetActor) continue;
      const existing = targetActor.items.find(i => i.type === "status" && i.name === sourceStatus.name);
      if (existing) {
        const newCount = (Number(existing.system.count) || 0) + stacksToAdd;
        await existing.update({ "system.count": newCount });
        ui.notifications.info(`${sourceStatus.name} on ${targetActor.name} → ${newCount}.`);
      } else {
        const newItem        = sourceStatus.toObject();
        newItem.system.count = stacksToAdd;
        await targetActor.createEmbeddedDocuments("Item", [newItem]);
        ui.notifications.info(`Applied ${stacksToAdd}x ${sourceStatus.name} to ${targetActor.name}.`);
      }
    }
  });
});
