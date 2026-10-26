export const MAPLE_ORIGIN = (process.env.NEXT_PUBLIC_MAPLE_ORIGIN || "https://maple.brooker.family").replace(/\/+$/, "");
export const MAPLE_HOST = new URL(MAPLE_ORIGIN).host;
export const MCP_URL = `${MAPLE_ORIGIN}/api/maple/mcp`;
