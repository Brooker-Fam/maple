import { createHash } from "node:crypto";

function output(uuid: string, name: string) {
  return { Value: { Type: "ActionOutput", OutputUUID: uuid, OutputName: name }, WFSerializationType: "WFTextTokenAttachment" };
}

function text(string: string, attachmentsByRange = {}) {
  return { Value: { string, attachmentsByRange }, WFSerializationType: "WFTextTokenString" };
}

function dictionary(key: string, value: ReturnType<typeof text>) {
  return {
    Value: { WFDictionaryFieldValueItems: [{ WFItemType: 0, WFKey: text(key), WFValue: value }] },
    WFSerializationType: "WFDictionaryFieldValue",
  };
}

export function shortcutTemplate(name: string, command: string, origin: string) {
  const endpoint = new URL("/api/maple/quick", origin);
  if (endpoint.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(endpoint.hostname)) throw new Error("Shortcuts require HTTPS");
  const ids = ["key", "request", "speech"].map((part) => {
    const hash = createHash("sha256").update(`${name}:${part}`).digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  });
  const action = (identifier: string, parameters: Record<string, unknown>) => ({
    WFWorkflowActionIdentifier: `is.workflow.actions.${identifier}`, WFWorkflowActionParameters: parameters,
  });
  return {
    WFWorkflowName: name,
    WFWorkflowClientVersion: "2600",
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowIcon: { WFWorkflowIconStartColor: 4291458815, WFWorkflowIconGlyphNumber: 59511 },
    WFWorkflowTypes: [],
    WFWorkflowInputContentItemClasses: [],
    WFWorkflowImportQuestions: [{
      ActionIndex: 0, Category: "Parameter", ParameterKey: "WFTextActionText",
      Text: "Paste the key you copied from Maple. Keep it private; it connects this shortcut to your family.", DefaultValue: "",
    }],
    WFWorkflowActions: [
      action("gettext", { WFTextActionText: "", UUID: ids[0] }),
      action("downloadurl", {
        WFURL: endpoint.toString(), WFHTTPMethod: "POST", WFHTTPBodyType: "JSON",
        WFHTTPHeaders: dictionary("Authorization", text("Bearer \ufffc", { "{7, 1}": { Type: "ActionOutput", OutputUUID: ids[0], OutputName: "Text" } })),
        WFJSONValues: dictionary("action", text(command)), UUID: ids[1],
      }),
      action("getvalueforkey", { WFDictionaryKey: "speak", WFInput: output(ids[1], "Contents of URL"), UUID: ids[2] }),
      action("speaktext", { WFText: text("\ufffc", { "{0, 1}": { Type: "ActionOutput", OutputUUID: ids[2], OutputName: "Dictionary Value" } }), WFSpeakTextWait: true }),
    ],
  };
}
