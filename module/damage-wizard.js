dialog.render(true);

Hooks.once("renderDialog", (app, html) => {
  const select = html.find('[name="defender_die_type"]');
  const input = html.find('[name="defender_die"]');

  select.on("change", () => {
    input.toggle(select.val() !== "unopposed");
  });

  html.find(".damage_wizard_button").on("click", async () => {
    const target = game.user.targets.first();
    if (!target) return ui.notifications.warn("Target a token!");

    await resolveDamage(payload, html, target.actor);
    app.close();
  });
});