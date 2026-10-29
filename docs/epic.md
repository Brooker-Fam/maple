# Epic / MyChart growth import

Maple can make a one-time, owner-initiated import of supported growth measurements from Epic. Start with Epic's synthetic sandbox; the first production target is Albany Med Health System. This is a standalone patient-facing SMART on FHIR connection: the owner opens it from Maple, signs in on the healthcare organization's page, selects the child's record if proxy access is offered, confirms the child, then chooses measurements to save.

This implementation does not register an Epic app, provision credentials, verify Albany Med child-proxy access or establish production connectivity. The person responsible for Maple must use their own Epic developer account to complete the setup below. No MyChart password belongs in Maple's configuration, source code, issue tracker or support messages.

## Scope and access

- Only a signed-in family owner can start, review, save or remove an import. Being an owner in Maple does not establish authorization to access a child's medical record; MyChart must authorize that separately.
- The initial request reads the selected patient's name and birth date. In production, the owner must confirm the child, and the date of birth must match the family's baby before Maple fetches supported growth measurements. Sandbox permits a synthetic patient's missing or mismatching birth date for preview only; saving sandbox measurements is always prohibited.
- The preview lets the owner choose individual measurements. Saving requires an explicit acknowledgement that the saved points become part of the shared baby log. Members and viewers can read them, and permitted Maple chat / MCP users can retrieve them through the existing baby-log tools.
- Each saved point has `source: "epic"` and preserves its source, observation date, value and units. Its value, time and source note are read-only in the app and assistants; normal delete/restore remains available. Source references prevent importing the same FHIR observation twice. An updated source observation does not automatically overwrite a previously imported point.
- Sandbox mode is preview-only: synthetic data cannot be saved in a family's growth log.
- This version has no writeback, clinician messaging, chart embedding, automatic sync, refresh tokens, mother-record import or full-chart storage. Reauthorize for each import.

## Server configuration

Set these in the intended Vercel environment and redeploy. Keep the feature disabled until the matching registration and tests are complete. Do not add secrets to `.env` files in git, logs, screenshots or this document.

| Variable | Value / purpose |
| --- | --- |
| `MAPLE_EPIC_ENABLED` | `1` enables new imports. Without it, new imports are disabled; owners who have saved imports can still reach their removal controls. |
| `MAPLE_EPIC_ENVIRONMENT` | `sandbox` for synthetic Epic data; `albany-med` for the configured production organization. |
| `MAPLE_EPIC_CLIENT_ID` | Epic's **non-production** client ID for sandbox, or the matching **production** client ID for Albany Med. A client ID is not a password. |
| `MAPLE_EPIC_ENCRYPTION_KEY` | Base64 encoding of 32 cryptographically random bytes; server-only key for pending authorization/import data. |
| `NEXT_PUBLIC_MAPLE_ORIGIN` | The canonical deployed origin, normally `https://maplebaby.app`. The code derives `MAPLE_ORIGIN` from this value. |

The exact redirect URI is `${MAPLE_ORIGIN}/api/maple/epic/callback`, normally:

```text
https://maplebaby.app/api/maple/epic/callback
```

Use a stable HTTPS test deployment with its own exact registered callback if testing outside the production origin. Do not use wildcard callbacks or assume a random Vercel preview URL is registered. The same browser must retain its Maple session through the redirect.

Imports are supported in a browser or installed PWA. The native wrappers direct owners to open Maple in a browser because the system-browser MyChart flow does not share the embedded app's session. Sign in to Maple in that browser before importing. Measurements already saved to the family log display on all platforms.

Maple uses a **public OAuth client with S256 PKCE**, even though it exchanges the code on its server. Do not configure a confidential client, add a client secret, enable backend/system access, or grant offline access for this implementation. The encryption key is Maple's own storage key, not an Epic client secret. Rotating it invalidates outstanding pending imports; remove those records through the normal support process before rotation if physical deletion is required.

The allowlisted endpoint configuration, verified against public metadata on October 29, 2026, is:

| Endpoint | Sandbox | Albany Med |
| --- | --- | --- |
| FHIR R4 base | `https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4` | `https://epicproxy.et1299.epichosted.com/FHIRProxy/api/FHIR/R4` |
| Authorization | `https://fhir.epic.com/interconnect-fhir-oauth/oauth2/authorize` | `https://epicproxy.et1299.epichosted.com/FHIRProxy/oauth2/authorize` |
| Token exchange | `https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token` | `https://epicproxy.et1299.epichosted.com/FHIRProxy/oauth2/token` |

The [sandbox metadata](https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/.well-known/smart-configuration) and [Albany Med metadata](https://epicproxy.et1299.epichosted.com/FHIRProxy/api/FHIR/R4/.well-known/smart-configuration) advertise public clients, standalone patient context and S256. This verifies advertised capabilities, not authorization of Maple's registration or pediatric proxy behavior. Use the exact FHIR base as `aud`. The requested SMART v1 scopes are `launch/patient patient/Patient.read patient/Observation.read`; `.read` covers read/search in that version. Neither `offline_access` nor `online_access` is needed. The selected child comes from the token response's `patient` context, not the signed-in parent's identity.

## Register the application in Epic

Use [open.epic](https://open.epic.com/) / [Epic on FHIR](https://fhir.epic.com/) with the developer account responsible for Maple. These are setup instructions, not a statement that an account or app has already been created. Public APIs and self-service tools do not require Vendor Services or a Showroom listing. See the [official developer support comparison](https://open.epic.com/EpicSupport).

In **Build Apps → Create App**, use the following values or their current UI equivalents:

| Registration field | Maple setting |
| --- | --- |
| Application name | `Maple Baby` (or the existing registered product name). |
| Primary users | **Patients**. Parents use MyChart's authorized proxy selection; they are not clinician or backend users. |
| Launch / use case | Standalone patient-facing app, read-only record access. The flow starts in Maple. |
| FHIR version | **R4**. |
| FHIR ID length | Enable **64-Character-Limited FHIR IDs** for the USCDI resources; Maple validates standard FHIR IDs up to 64 characters. |
| Client confidentiality | **Public / non-confidential**, authorization code flow with **S256 PKCE**. |
| Redirect URI | The exact callback above for each intended stable deployment. |
| Incoming APIs | **Patient.Read (Demographics) (R4)** and **Observation.Search (Vital Signs) (R4)** only. Review Epic's current catalog labels and USCDI eligibility before saving. |
| Refresh / persistent access | Disabled; do not request `offline_access`. |
| Public website | Maple's actual canonical origin. |
| Privacy policy / terms | The deployed `/privacy` and `/terms` pages on that origin. |
| Support contact | The maintained `CONTACT_EMAIL` in `src/components/site/legal.tsx` (currently `hello@maplebaby.app`). |
| Summary | `Parents can review and import selected growth measurements into their family's Maple Baby log.` |
| Description | Explain patient authorization, confirmation of the selected child, one-time import, shared-family visibility and the optional AI access described below. Do not claim endorsement, certification or a live hospital partnership. |

Do not add Observation.Create, broader clinical resources, billing, appointments, messaging or private APIs to solve an authorization error. First check registration, scopes, client distribution and the child's proxy permissions. The implementation determines the requested OAuth scopes; registration must allow those reads and patient context without write or offline access.

The growth reader requests weight (LOINC `29463-7` / `3141-9`), length or height (`8302-2` / `8306-3`), and head circumference (`8287-5`). It validates the selected patient, final/amended/corrected status, measurement date and supported UCUM units before displaying a point. Unsupported or incomplete records are excluded; an empty preview does not establish that the chart has no growth history. See [Epic's vital-sign API](https://fhir.epic.com/Specifications?api=973).

Complete Epic's **Data Use Questionnaire** from the deployed behavior and the current privacy policy. Answer every relevant question honestly, including:

- Maple stores selected clinical measurements in its cloud-hosted family log after explicit confirmation. It is not an on-device-only viewer.
- Everyone permitted to read the baby log, including view-only guests, can read saved imports. The importing owner must authorize this sharing.
- Maple's optional chat and connected assistants can process saved measurements under existing permissions. Do not answer that medical information can never reach AI or other service providers.
- Pending authorization and preview data are encrypted and short-lived in use; expiry and physical cleanup differ, as described below. Saved measurements remain until removed or the family is deleted.
- Maple does not sell the data, use it for ads, or send it back to the healthcare organization in this version.
- Explain the removal control and the separate retention of existing chat/export copies. Do not promise deletion of external copies Maple cannot control.

Save the draft registration and use its **non-production client ID** for sandbox testing. Keep the technical configuration settled before marking the app **Ready for Production**: Epic restricts changes to an activated app, so API/user-type changes can require a new registration. Use the current [app creation documentation](https://fhir.epic.com/Documentation?docId=epiconfhirrequestprocess) as the authority for the portal's current process.

## Sandbox verification

Use only synthetic records from [Epic's sandbox documentation](https://fhir.epic.com/Documentation?docId=testpatients). Never upload actual patient records to a sandbox, save real passwords in fixtures, or create test data inside a real child's chart.

1. Configure the sandbox environment and non-production client ID; leave production credentials out of the deployment.
2. As an owner, open the MyChart import setting and complete the browser redirect. Verify the healthcare organization's sign-in page, then review the selected patient in Maple.
3. Confirm that switching family or signing out invalidates the pending flow. Sandbox may preview a synthetic patient whose birth date is missing or differs from the family's baby. Separately, use the automated production-mode checks with synthetic responses to verify that a missing or mismatching birth date blocks growth retrieval and a parent/adult record cannot be silently linked to the baby.
4. Confirm the synthetic sandbox record and inspect the growth preview without changing a real baby's details to match it. Sandbox must always refuse saving those measurements to the family log, whether or not the birth dates match.
5. Verify cancellation, denied consent, expired/reused state, missing session, missing scopes, token failure and an empty measurement result. None should create entries or expose provider responses/tokens in logs or analytics.
6. Run the checks below. Local fixtures and the sandbox do not validate the Albany Med production endpoint or child-proxy behavior.

```sh
pnpm check:maple-epic
pnpm check:maple-epic-ui
pnpm typecheck
pnpm lint
```

The API checks cover synthetic FHIR parsing, storage and the authorization/import flow. The browser checks cover the import screens using synthetic responses. Confirm a stale tab cannot approve or discard a newer pending import, and imported values cannot be edited through the app or assistant tools.

## Albany Med production activation

After sandbox checks, use the current [patient-facing app distribution guidance](https://fhir.epic.com/Documentation?docId=patientfacingfhirapps&section=AutomaticClientDistribution): keep the registration patient-facing, read-only and limited to qualifying USCDI APIs, choose the applicable **Enable Auto-download** option, and mark it Ready for Production. Automatic distribution depends on the organization's Epic version, API licensing and whether it allows auto-download; it is not a guarantee of availability or of child-proxy access.

Switch the deployment to `MAPLE_EPIC_ENVIRONMENT=albany-med` and the matching **production** client ID only after registration is ready. Keep `MAPLE_EPIC_ENABLED` off until the operator is ready for a controlled verification. The implementation uses an allowlisted organization rather than accepting a FHIR URL supplied by a browser; endpoint changes need code review and verification against Epic's [endpoint directory](https://open.epic.com/MyApps/Endpoints).

The parent must already have the appropriate child-proxy permission at Albany Med. A child visible in the MyChart website is not proof that its third-party FHIR authorization works. Verify the actual authorization screen offers the child and Maple receives that child's identity. If only the parent's record appears, stop that import and resolve the proxy limitation with the healthcare organization through its normal support channel. Do not substitute the parent's identifier, scrape the portal, or relax birth-date matching.

For the first real import, verify the correct child, the source date and units, and the sharing acknowledgement before saving a small selected set. Confirm the points in the growth log. Reauthorize and preview again to verify duplicate suppression. Exercise the removal control only on points the owner intends to remove. Test other family roles to confirm they cannot start an import but can see points the owner knowingly shared.

Adding the feature and registering a client does not attest that this production verification happened. Record the environment, app registration and synthetic check outcomes without recording credentials, patient identities or clinical values in this public repository.

## Retention, deletion and support

The OAuth flow is bound to the initiating Maple browser session, member and family. Authorization attempts are single-use. Every patient confirmation, save and discard carries the pending import's UUID; an older tab cannot approve or discard a replacement import. Pending tokens and the minimal patient/preview information are encrypted with `MAPLE_EPIC_ENCRYPTION_KEY`; they cannot be used after at most 15 minutes, or sooner if the access token expires. Successful save, explicit discard or removal clears the pending record. Expired rows are physically cleared during enabled importer requests and by the existing daily push-tick cleanup when that routine runs. Ciphertext can persist beyond the usability deadline until cleanup executes. This is not a scheduled 15-minute deletion guarantee; monitor the existing cleanup routine's operation. Database-host backups follow the host's retention policy.

Imported points retain source references sufficient for deduplication and source notes, not a raw FHIR chart. Shared notes preserve the measurement's original date, value and unit, without copying the FHIR patient ID or name. Normal entry deletion still uses Maple's existing soft-delete behavior and permits restoration. The settings import count includes those hidden points. The dedicated remove-imported control hard-deletes that owner's imported measurements in the current family, including soft-deleted ones, and discloses that scope before removal. It does not rewrite a hospital chart or erase earlier CSVs, doctor summaries, chat snapshots or third-party assistant histories. Chat history and external copies need their own deletion actions. A family deletion must also include its pending Epic records and import bookkeeping.

Do not log access tokens, authorization codes, PKCE verifiers, patient names, birth dates, FHIR bodies or clinical measurements. Use bounded error categories without provider response bodies. If an import fails, inspect configuration and synthetic checks before asking a parent for any clinical detail. Disabling the feature prevents new use; it is not a deletion operation for points already imported.

Privacy and terms describe this conditional feature in legal version **1.14 (October 29, 2026)**. Keep those pages, the import confirmation and Epic's Data Use Questionnaire aligned with any future change to storage, sharing, refresh/background access or writeback.
