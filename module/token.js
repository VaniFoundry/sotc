/**
 * Extend the base TokenDocument to support resource type attributes.
 * @extends {TokenDocument}
 */
export class SotCTokenDocument extends TokenDocument {

  /** @inheritdoc */
  getBarAttribute(barName, {alternative}={}) {
    const data = super.getBarAttribute(barName, {alternative});
    const attr = alternative || this[barName]?.attribute;
    if ( !data || !attr || !this.actor ) return data;
    const current = foundry.utils.getProperty(this.actor.system, attr);
    if ( current?.dtype === "Resource" ) data.min = parseInt(current.min || 0);
    data.editable = true;
    return data;
  }

  /* -------------------------------------------- */
  /* This thing seems to be messing up the Combat Tracker Settings, so I have e x p u n g e d it.
  static getTrackedAttributes(data = {}, _path = []) {
    return super.getTrackedAttributes(data, _path);
  }
  */
}


/* -------------------------------------------- */


/**
 * Extend the base Token class to implement additional system-specific logic.
 * @extends {Token}
 */
export class SotCToken extends Token {
  _drawBar(number, bar, data) {
    if ( "min" in data ) {
      // Copy the data to avoid mutating what the caller gave us.
      data = {...data};
      // Shift the value and max by the min to draw the bar percentage accurately for a non-zero min
      data.value -= data.min;
      data.max -= data.min;
    }
    return super._drawBar(number, bar, data);
  }
}
