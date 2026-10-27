const FIXED = Date.parse("2026-10-27T14:00:00.000Z");
const RealDate = Date;
globalThis.__clockOffset = 0;
const now = () => FIXED + globalThis.__clockOffset;
class FrozenDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(now());
    else super(...args);
  }
  static now() {
    return now();
  }
}
globalThis.Date = FrozenDate;
