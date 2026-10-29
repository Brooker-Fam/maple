import { MAPLE_ORIGIN } from "../origin";

/** Fixed destinations only. No caller-controlled issuer, redirect, or token host. */
export const EPIC_PROVIDERS = {
  sandbox: {
    id: "sandbox", name: "Epic test records", sandbox: true,
    baseUrl: "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4",
    authorizeUrl: "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/authorize",
    tokenUrl: "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token",
  },
  "albany-med": {
    id: "albany-med", name: "Albany Med Health System", sandbox: false,
    baseUrl: "https://epicproxy.et1299.epichosted.com/FHIRProxy/api/FHIR/R4",
    authorizeUrl: "https://epicproxy.et1299.epichosted.com/FHIRProxy/oauth2/authorize",
    tokenUrl: "https://epicproxy.et1299.epichosted.com/FHIRProxy/oauth2/token",
  },
} as const;

export type EpicProvider = (typeof EPIC_PROVIDERS)[keyof typeof EPIC_PROVIDERS];
export type EpicConfig = { provider: EpicProvider; clientId: string; redirectUri: string; origin: string };
export const EPIC_SCOPES = "launch/patient patient/Patient.read patient/Observation.read";
export const REVIEW_TTL_MS = 15 * 60_000;

export function encryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.MAPLE_EPIC_ENCRYPTION_KEY ?? "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(raw)) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 && key.toString("base64") === raw ? key : null;
}

/** Configuration is explicit: no default to a real health system or another environment's ID. */
export function epicConfig(env: NodeJS.ProcessEnv = process.env): EpicConfig | null {
  if (env.MAPLE_EPIC_ENABLED !== "1" || !encryptionKey(env)) return null;
  const id = env.MAPLE_EPIC_ENVIRONMENT;
  if (id !== "sandbox" && id !== "albany-med") return null;
  const clientId = env.MAPLE_EPIC_CLIENT_ID?.trim();
  if (!clientId || !/^[A-Za-z0-9._-]{1,200}$/.test(clientId)) return null;
  const origin = new URL(MAPLE_ORIGIN);
  if (origin.origin !== MAPLE_ORIGIN || (origin.protocol !== "https:" && !(id === "sandbox" && ["localhost", "127.0.0.1"].includes(origin.hostname) && origin.protocol === "http:"))) return null;
  return { provider: EPIC_PROVIDERS[id], clientId, origin: origin.origin, redirectUri: `${origin.origin}/api/maple/epic/callback` };
}
