# Stars of the City - SotC - FoundryVTT System

"A simple game system for Foundry VTT which allows for flexible definition of Actors and Items to assist with worldbuilding or for running games which do not have a more complete system implementation available. - Atropos"

Or that is how it was originally. It is now... very specialized. It's not exceptionally complicated at any given point. The code is all fairly straight forward.
But still, it's not so mundane or generic anymore. This is targeted for the Stars of the City system made by JakkaFang, but could also be used for other
Library of Ruina / Limbus inspired systems. I may even eventually make a version of the system that permits coin based gameplay, instead of dice based.

But for now, this is a fairly basic implementation that in the future will have several things added, as below.

Feature Forecast
 - Modification of Dice Rolls and Derived Character Sheet Statistics by the effects of passive status effects. This will likely mimic the pathfinder system,
	it's solely due to scope limitation that this version doesn't already include this particular feature
 - Application of modules to skills that actually have active or passive effects
	- i.e. dice readout includes a button for "Apply X Burn" using the foundry target system to apply a status effect. This would require the 
	  hookup of dice modules as more than just text
	- Actual activation of on use and after use as more than text
	- Easy implementation of [check] tags
 - Implementation of blaze, maybe? The problem is that, even though I could nuke every npc with burn pretty easily I'd need to get an IFF system
 - Maybe eventually make passive entries also be able to apply bonuses, like Ruina keypages would
 - Add level up mechanics for minor improvements
 - Add language support for any requested languages
 - Rework statuses to use foundry default status system for module compatability <- I hate that I once wrote this
 - The mess that is turn-end effects, like light regen or status effects. Bleh...
 - Trackers, like for whether an ego passive is active or not
 - Option to print-out status effects to chat (currently I encourage you to just have the description written separately as a passive saying something
	like "Unit X applies Y effect with some skills. Y effect does Z."
 - NPC Sheet
 - Draggable skills/passives/statuses and everything foundry considers to be an item
 - Automation of anxieties and injuries for attempts
 - Indicator of Max/Min roll on a dice to point out crits
 - Dynamic modification of stats like damage affinities to reflect passives AND
 - Button-press application of damage/stagger to a character after roll, hypothetically allowing for defensive dice or bonuses to damage/stagger to be recognized

Requested Changes
 - Tsuchigumo and TrueQueenOfRose: Let status effects target/be applied to skills on the character's sheet, for effects like Ember or Pebble or Lock
					the intention being to either mechanically change power, light cost, or mechanically change something on roll

Now, I'll add these gradually over time, but I'd also like to more or less have my finger on the pulse of the users as for what new features are wanted
To this end, please feel free to contact my, Tsubasa, via my discord: tsubasa______

Changelog:
v1.01
 - Resolved an issue with initiative, in which player connected machines would rerun initiative logic and EXPLODE the order with duplicates (sotc.js)
 - Corrected Strength to Might on the character sheet (actor-sheet.html)
 - Made the dice section of skills scrollable, for instances with a lot of modules or a lot of dice. Go forth and be absurd (sotc.css)
 - Changed the printout of modules placed on skills for the chat dialog so that there was less aggressive whitespace trimming (actor-sheet.js)
 - Fixed an issue in which status effects with long names would have bad formatting (sotc.css)
 - Added an "Other" option for status effects (template.json, status-sheet.html, actor-sheet.html, actor-sheet.js)
 - Added the option for status effects to result in a flat increase, regardless of count, alla Strider [Mao] (actor-sheet.html, status-sheet.html)
 - Added an option for a status to target "All Dice Power" (status-sheet.html)
 - Changed the biography tab to use the same entry format as the passives tab, allowing for potentially infinite biography entries and printability (actor-sheet.js, actor-sheet.html)
 - Updated the formatting for the Passives (and now Biography) tab to better accommodate larger entries (sotc.css, actor-sheet.html)

v1.02
 - Provided substantial support for dice to be rolled individually or rerolled selectively
 - Thanks to _twitch_ for pointing out an issue with combantant creation. Quite possibly my GOAT.
 - Made the initiative tracker better
 - Made passive status effects that target dice rolls apply automatically
 - More stuff in the discord post that I cannot be bothered to rewrite here. It's 3am, man.

v1.03
 - I'm not gonna clutter this up too much, so I've added a changelog .txt instead. Is that good form? Idk. 
 - Oh hey look, on the last update I also said it was 3am. It's 3am again now! Haha!

v1.04
 - with the next update I'm gonna move v1.01 and v1.02 to the changelog and just keep v1.03 onwards here, I'm just too lazy to do it right now.
- v13 of foundry is now system compatible. Previously actor sheets and passive sheets were not possible to open
- In v13, haste/bind would only work on the first speed dice of an actor. This is now resolved for realsies
- v13 formatting for dice summaries and a bunch of other stuff was all screwed up. It's better now
- The v13 actor sheet was messed up compared to v11. It's better now
- Passive sheet had some stuff not rendering in v13, now fixed