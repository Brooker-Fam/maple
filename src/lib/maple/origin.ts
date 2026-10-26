export const MAPLE_ORIGIN = (process.env.NEXT_PUBLIC_MAPLE_ORIGIN || "https://maplebaby.app").replace(/\/+$/, "");
export const MAPLE_HOST = new URL(MAPLE_ORIGIN).host;
export const MCP_URL = `${MAPLE_ORIGIN}/api/maple/mcp`;
/** brooker.family/maple forwards here, so phones that installed Maple there sign in through it too. */
export const LEGACY_ORIGIN = "https://brooker.family";
