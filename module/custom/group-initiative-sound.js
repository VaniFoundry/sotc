/**
 * group-initiative-sound.js
 * Foundry VTT v13 — plays a custom sound when rolling ALL initiatives at once.
 */

console.log("group-initiative-sound | FILE LOADED ✓");

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const GROUP_INITIATIVE_SOUND = {
  // Full path from Foundry Data root — adjust your system name!
  src: "systems/sotc/assets/audio/speed_dice.mp3",
  volume: 0.8,
  broadcast: true,
};

// ─────────────────────────────────────────────────────────────────────────────

function registerRollAllPatch() {
  // ── libWrapper (preferred) ──────────────────────────────────────────────
  if (typeof libWrapper !== "undefined") {
    try {
      libWrapper.register(
        "sotc",                          // ← must match your system id in system.json
        "Combat.prototype.rollAll",
        async function (wrapped, ...args) {
          console.log("group-initiative-sound | rollAll intercepted (libWrapper) ✓");
          await playGroupInitiativeSound();
          return wrapped(...args);
        },
        "WRAPPER"
      );
      console.log("group-initiative-sound | registered via libWrapper ✓");
      return true;
    } catch (e) {
      console.warn("group-initiative-sound | libWrapper registration failed, falling back.", e);
    }
  }

  // ── Direct prototype patch ──────────────────────────────────────────────
  if (typeof Combat !== "undefined" && Combat.prototype.rollAll) {
    const _rollAll = Combat.prototype.rollAll;
    Combat.prototype.rollAll = async function (...args) {
      console.log("group-initiative-sound | rollAll intercepted (prototype patch) ✓");
      await playGroupInitiativeSound();
      return _rollAll.call(this, ...args);
    };
    console.log("group-initiative-sound | registered via prototype patch ✓");
    return true;
  }

  return false; // Combat not ready yet
}

// Try immediately at top level
if (!registerRollAllPatch()) {
  console.log("group-initiative-sound | Combat not ready, waiting for hooks…");
  Hooks.once("init", () => {
    if (!registerRollAllPatch()) {
      Hooks.once("setup", () => {
        if (!registerRollAllPatch()) {
          console.error("group-initiative-sound | ✗ Failed to patch Combat.prototype.rollAll — does your system define rollAll?");
        }
      });
    }
  });
}

// ─── Helper ──────────────────────────────────────────────────────────────────

async function playGroupInitiativeSound() {
  const { src, volume, broadcast } = GROUP_INITIATIVE_SOUND;

  if (!src) {
    console.warn("group-initiative-sound | No sound src configured.");
    return;
  }

  console.log(`group-initiative-sound | Attempting to play: ${src}`);

  try {
    if (foundry?.audio?.AudioHelper) {
      await foundry.audio.AudioHelper.play({ src, volume, autoplay: true, loop: false }, broadcast);
      console.log("group-initiative-sound | Played via foundry.audio.AudioHelper ✓");
      return;
    }
    if (typeof AudioHelper !== "undefined") {
      await AudioHelper.play({ src, volume, autoplay: true, loop: false }, broadcast);
      console.log("group-initiative-sound | Played via AudioHelper ✓");
      return;
    }
    console.error("group-initiative-sound | No AudioHelper found.");
  } catch (e) {
    console.error("group-initiative-sound | Error playing sound:", e);
  }
}