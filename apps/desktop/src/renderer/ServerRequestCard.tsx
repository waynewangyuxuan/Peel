import type { AppServerServerRequest, JsonValue } from "@peel/codex-app-server";
import { serverRequestRoute } from "@peel/codex-app-server/protocol";
import { useMemo, useState, type ReactNode } from "react";

import type { ServerRequestResponseInput } from "../shared/contracts";

interface Props {
  request: AppServerServerRequest;
  onRespond(input: ServerRequestResponseInput): Promise<void>;
}

export function requestThreadId(request: AppServerServerRequest): string | null {
  const params = recordOf(request.params);
  if (typeof params.threadId === "string") return params.threadId;
  if (typeof params.conversationId === "string") return params.conversationId;
  return null;
}

export function requestTurnId(request: AppServerServerRequest): string | null {
  const value = recordOf(request.params).turnId;
  return typeof value === "string" ? value : null;
}

export function ServerRequestCard({ request, onRespond }: Props): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const respond = async (input: ServerRequestResponseInput): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRespond(input);
    } catch (caught) {
      setError(messageOf(caught));
      setBusy(false);
    }
  };
  const route = serverRequestRoute(request.method);
  let body: ReactNode;
  if (route === "command-approval") body = <CommandApproval request={request} busy={busy} respond={respond}/>;
  else if (route === "file-change-approval") body = <FileChangeApproval request={request} busy={busy} respond={respond}/>;
  else if (route === "user-input") body = <UserInputRequest request={request} busy={busy} respond={respond}/>;
  else if (route === "permissions") body = <PermissionsRequest request={request} busy={busy} respond={respond}/>;
  else if (route === "mcp-elicitation") body = <McpElicitation request={request} busy={busy} respond={respond}/>;
  else return null;
  return <section className={`request-card request-${route}`} aria-label={requestLabel(route)}>
    {body}
    {error && <div className="request-error" role="alert">{error}</div>}
  </section>;
}

function CommandApproval({ request, busy, respond }: RequestBodyProps): ReactNode {
  const params = recordOf(request.params);
  const isStdin = params.kind === "writeStdin";
  const command = typeof params.command === "string" ? params.command : "Codex needs permission to continue this command.";
  const reason = typeof params.reason === "string" ? params.reason : null;
  const network = isRecord(params.networkApprovalContext);
  const proposedExecpolicyAmendment = isRecord(params.proposedExecpolicyAmendment);
  const proposedNetworkPolicyAmendments = Array.isArray(params.proposedNetworkPolicyAmendments) ? params.proposedNetworkPolicyAmendments : [];
  return <>
    <RequestHeader title={isStdin ? "Terminal input approval" : network ? "Network command approval" : "Command approval"} detail={reason}/>
    <pre className="request-command"><code>{command}</code></pre>
    {(proposedExecpolicyAmendment || proposedNetworkPolicyAmendments.length > 0) && <div className="request-amendments" aria-label="Proposed approval rules">
      {proposedExecpolicyAmendment && <button disabled={busy} onClick={() => void respond({ id: request.id, kind: "command", decision: "acceptProposedExecpolicyAmendment" })}>Allow matching commands</button>}
      {proposedNetworkPolicyAmendments.map((_amendment, index) => <button key={index} disabled={busy} onClick={() => void respond({ id: request.id, kind: "command", decision: { applyProposedNetworkPolicyAmendment: index } })}>Apply proposed network rule {proposedNetworkPolicyAmendments.length > 1 ? index + 1 : ""}</button>)}
    </div>}
    <DecisionRow busy={busy} onDecline={() => void respond({ id: request.id, kind: "command", decision: "decline" })} onSession={() => void respond({ id: request.id, kind: "command", decision: "acceptForSession" })} onAccept={() => void respond({ id: request.id, kind: "command", decision: "accept" })}/>
  </>;
}

function FileChangeApproval({ request, busy, respond }: RequestBodyProps): ReactNode {
  const params = recordOf(request.params);
  const reason = typeof params.reason === "string" ? params.reason : null;
  return <>
    <RequestHeader title="File change approval" detail={reason}/>
    <p className="request-summary">{typeof params.grantRoot === "string" ? "Codex is requesting additional write access for this task." : "Codex is ready to apply file changes."}</p>
    <DecisionRow busy={busy} onDecline={() => void respond({ id: request.id, kind: "file-change", decision: "decline" })} onSession={() => void respond({ id: request.id, kind: "file-change", decision: "acceptForSession" })} onAccept={() => void respond({ id: request.id, kind: "file-change", decision: "accept" })}/>
  </>;
}

function UserInputRequest({ request, busy, respond }: RequestBodyProps): ReactNode {
  const questions = Array.isArray(recordOf(request.params).questions)
    ? (recordOf(request.params).questions as unknown[]).filter(isRecord)
    : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const complete = questions.length > 0 && questions.every((question) => typeof question.id === "string" && Boolean(answers[question.id]?.trim()));
  return <>
    <RequestHeader title="Codex needs your input" detail="Answer to continue this Turn."/>
    <div className="request-questions">{questions.map((question, index) => {
      const id = typeof question.id === "string" ? question.id : `question-${index}`;
      const label = typeof question.question === "string" ? question.question : "Choose an answer";
      const options = Array.isArray(question.options) ? question.options.filter(isRecord) : [];
      return <fieldset key={id}>
        <legend>{label}</legend>
        {options.map((option, optionIndex) => {
          const value = typeof option.label === "string" ? option.label : `Option ${optionIndex + 1}`;
          return <label className="request-option" key={value}>
            <input type="radio" name={`${String(request.id)}-${id}`} value={value} checked={answers[id] === value} onChange={() => setAnswers((current) => ({ ...current, [id]: value }))}/>
            <span><strong>{value}</strong>{typeof option.description === "string" && <small>{option.description}</small>}</span>
          </label>;
        })}
        {(options.length === 0 || question.isOther === true) && <input
          className="request-text-input"
          type={question.isSecret === true ? "password" : "text"}
          aria-label={options.length > 0 ? `${label} — Other` : label}
          placeholder={options.length > 0 ? "Other answer" : "Type your answer"}
          onChange={(event) => setAnswers((current) => ({ ...current, [id]: event.target.value }))}
        />}
      </fieldset>;
    })}</div>
    <div className="request-actions"><button className="primary" disabled={busy || !complete} onClick={() => void respond({ id: request.id, kind: "user-input", answers: Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, [answer.trim()]])) })}>Submit answers</button></div>
  </>;
}

function PermissionsRequest({ request, busy, respond }: RequestBodyProps): ReactNode {
  const params = recordOf(request.params);
  const permissions = recordOf(params.permissions);
  const network = recordOf(permissions.network);
  const fileSystem = recordOf(permissions.fileSystem);
  const entries = Array.isArray(fileSystem.entries) ? fileSystem.entries.filter(isRecord) : [];
  const readCount = arrayLength(fileSystem.read) + entries.filter((entry) => entry.access === "read").length;
  const writeCount = arrayLength(fileSystem.write) + entries.filter((entry) => entry.access === "write").length;
  const denyCount = entries.filter((entry) => entry.access === "deny").length;
  const reason = typeof params.reason === "string" ? params.reason : null;
  return <>
    <RequestHeader title="Additional permission request" detail={reason}/>
    <ul className="permission-summary">
      {network.enabled !== null && network.enabled !== undefined && <li>{network.enabled === false ? "Keep network access disabled" : "Allow network access"}</li>}
      {readCount > 0 && <li>Read access to {readCount} additional location{readCount === 1 ? "" : "s"}</li>}
      {writeCount > 0 && <li>Write access to {writeCount} additional location{writeCount === 1 ? "" : "s"}</li>}
      {denyCount > 0 && <li>Keep {denyCount} location{denyCount === 1 ? "" : "s"} denied</li>}
    </ul>
    <div className="request-actions">
      <button disabled={busy} onClick={() => void respond({ id: request.id, kind: "permissions", decision: "deny", scope: "turn" })}>Deny</button>
      <button disabled={busy} onClick={() => void respond({ id: request.id, kind: "permissions", decision: "grant", scope: "turn" })}>Allow once</button>
      <button className="primary" disabled={busy} onClick={() => void respond({ id: request.id, kind: "permissions", decision: "grant", scope: "session" })}>Allow for session</button>
    </div>
  </>;
}

function McpElicitation({ request, busy, respond }: RequestBodyProps): ReactNode {
  const params = recordOf(request.params);
  const message = typeof params.message === "string" ? params.message : "An MCP server needs information to continue.";
  const serverName = typeof params.serverName === "string" ? params.serverName : "MCP server";
  const schema = recordOf(params.requestedSchema);
  const fields = recordOf(schema.properties);
  const required = Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : [];
  const defaults = useMemo(() => Object.fromEntries(Object.entries(fields).flatMap(([name, raw]) => {
    const field = recordOf(raw);
    return field.default === undefined ? [] : [[name, field.default]];
  })), [request.id]);
  const [values, setValues] = useState<Record<string, unknown>>(defaults);
  const [rawJson, setRawJson] = useState("{}");
  const mode = typeof params.mode === "string" ? params.mode : "form";
  const genericForm = mode === "openai/form" || mode === "openaiForm";
  const url = mode === "url" && typeof params.url === "string" && /^https:\/\//i.test(params.url) ? params.url : null;
  const complete = required.every((name) => values[name] !== undefined && values[name] !== "");
  const parsedJson = parseJson(rawJson);
  return <>
    <RequestHeader title={`${serverName} request`} detail={message}/>
    {mode === "url" ? <div className="elicitation-url">{url ? <a href={url} target="_blank" rel="noreferrer">Open secure request link</a> : <span>The supplied link is not a safe HTTPS URL.</span>}</div> : genericForm ? <label className="elicitation-field">
      <span>JSON response</span>
      <small>Provide structured content requested by this MCP server.</small>
      <textarea value={rawJson} aria-label="JSON response" onChange={(event) => setRawJson(event.target.value)}/>
      {!parsedJson.ok && <span className="request-error">Enter valid JSON.</span>}
    </label> : <div className="elicitation-fields">
      {Object.entries(fields).map(([name, raw]) => <ElicitationField key={name} name={name} schema={recordOf(raw)} required={required.includes(name)} value={values[name]} onChange={(value) => setValues((current) => ({ ...current, [name]: value }))}/>)}
    </div>}
    <div className="request-actions">
      <button disabled={busy} onClick={() => void respond({ id: request.id, kind: "mcp-elicitation", action: "cancel" })}>Cancel</button>
      <button disabled={busy} onClick={() => void respond({ id: request.id, kind: "mcp-elicitation", action: "decline" })}>Decline</button>
      <button className="primary" disabled={busy || (!genericForm && mode !== "url" && !complete) || (genericForm && !parsedJson.ok) || (mode === "url" && !url)} onClick={() => void respond({ id: request.id, kind: "mcp-elicitation", action: "accept", content: mode === "url" ? null : genericForm && parsedJson.ok ? parsedJson.value : values as JsonValue })}>{mode === "url" ? "Continue" : "Submit"}</button>
    </div>
  </>;
}

function ElicitationField({ name, schema, required, value, onChange }: {
  name: string;
  schema: Record<string, unknown>;
  required: boolean;
  value: unknown;
  onChange(value: unknown): void;
}): ReactNode {
  const title = typeof schema.title === "string" ? schema.title : name;
  const description = typeof schema.description === "string" ? schema.description : null;
  const choices = fieldChoices(schema);
  const multiple = schema.type === "array";
  return <label className="elicitation-field">
    <span>{title}{required ? " *" : ""}</span>
    {description && <small>{description}</small>}
    {schema.type === "boolean" ? <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)}/>
      : choices.length > 0 ? <select multiple={multiple} value={multiple && Array.isArray(value) ? value.map(String) : typeof value === "string" ? value : ""} onChange={(event) => onChange(multiple ? [...event.target.selectedOptions].map((option) => option.value) : event.target.value)}>{!multiple && <option value="">Choose…</option>}{choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>
        : <input type={schema.type === "number" || schema.type === "integer" ? "number" : formatInputType(schema.format)} min={typeof schema.minimum === "number" ? schema.minimum : undefined} max={typeof schema.maximum === "number" ? schema.maximum : undefined} value={typeof value === "string" || typeof value === "number" ? value : ""} onChange={(event) => onChange(schema.type === "number" || schema.type === "integer" ? event.target.valueAsNumber : event.target.value)}/>}
  </label>;
}

interface RequestBodyProps {
  request: AppServerServerRequest;
  busy: boolean;
  respond(input: ServerRequestResponseInput): Promise<void>;
}

function RequestHeader({ title, detail }: { title: string; detail: string | null }): ReactNode {
  return <header className="request-header"><strong>{title}</strong>{detail && <p>{detail}</p>}</header>;
}

function DecisionRow({ busy, onDecline, onSession, onAccept }: { busy: boolean; onDecline(): void; onSession(): void; onAccept(): void }): ReactNode {
  return <div className="request-actions">
    <button disabled={busy} onClick={onDecline}>Decline</button>
    <button disabled={busy} onClick={onSession}>Allow for task</button>
    <button className="primary" disabled={busy} onClick={onAccept}>Allow once</button>
  </div>;
}

function requestLabel(route: string): string {
  return route.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function fieldChoices(schema: Record<string, unknown>): Array<{ value: string; label: string }> {
  const direct = Array.isArray(schema.enum) ? schema.enum.filter((choice): choice is string => typeof choice === "string") : [];
  const names = Array.isArray(schema.enumNames) ? schema.enumNames.filter((choice): choice is string => typeof choice === "string") : [];
  if (direct.length > 0) return direct.map((value, index) => ({ value, label: names[index] ?? value }));
  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(recordOf(schema.items).oneOf) ? recordOf(schema.items).oneOf as unknown[] : [];
  const itemEnum = recordOf(schema.items).enum;
  if (Array.isArray(itemEnum)) return itemEnum.filter((choice): choice is string => typeof choice === "string").map((value) => ({ value, label: value }));
  return oneOf.filter(isRecord).flatMap((option) => typeof option.const === "string" ? [{ value: option.const, label: typeof option.title === "string" ? option.title : option.const }] : []);
}

function formatInputType(format: unknown): "text" | "email" | "url" | "date" | "datetime-local" {
  if (format === "email") return "email";
  if (format === "uri") return "url";
  if (format === "date") return "date";
  if (format === "date-time") return "datetime-local";
  return "text";
}

function parseJson(value: string): { ok: true; value: JsonValue } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as JsonValue };
  } catch {
    return { ok: false };
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
