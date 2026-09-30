import type { Element, ElementContent, Properties, Root, RootContent } from "hast";
import type { Plugin } from "unified";

const ALLOWED = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "em", "strong", "del",
  "ul", "ol", "li",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "pre", "code", "blockquote",
  "a", "img", "br", "hr",
]);

const DROP = new Set([
  "script", "style", "iframe", "object", "embed", "template",
  "svg", "math", "canvas",
  "audio", "video", "source", "track",
  "form", "button", "input", "select", "option", "textarea", "fieldset", "label",
  "details", "dialog",
  "link", "meta", "base",
]);

const LANGUAGE_CLASS = /^language-[A-Za-z0-9_-]+$/;
const ALIGN = new Set(["left", "center", "right"]);

export const rehypeSafeStaticHtml: Plugin<[], Root> = () => {
  return (tree) => {
    sanitizeChildren(tree);
  };
};

function sanitizeChildren(parent: Root | Element): void {
  const next: Array<RootContent | ElementContent> = [];
  for (const child of parent.children) {
    if (child.type === "text") {
      next.push(child);
      continue;
    }
    if (child.type === "comment" || child.type === "doctype" || child.type === "raw") continue;
    if (child.type !== "element") continue;

    const tag = child.tagName.toLowerCase();
    // GFM task lists emit input[type=checkbox]; every other input stays dropped.
    if (tag === "input") {
      const checkbox = pickCheckbox(child.properties);
      if (!checkbox) continue;
      child.tagName = "input";
      child.properties = checkbox;
      child.children = [];
      next.push(child);
      continue;
    }
    if (DROP.has(tag)) continue;

    if (ALLOWED.has(tag)) {
      child.tagName = tag;
      child.properties = rebuildProperties(tag, child.properties);
      sanitizeChildren(child);
      next.push(child);
      continue;
    }

    sanitizeChildren(child);
    next.push(...child.children);
  }
  parent.children = next as typeof parent.children;
}

function rebuildProperties(tag: string, raw: Properties | undefined): Properties {
  const source = raw ?? {};
  switch (tag) {
    case "a":
      return pickLink(source);
    case "img":
      return pickImage(source);
    case "ol":
      return pickOrderedList(source);
    case "li":
      return pickListItem(source);
    case "th":
    case "td":
      return pickCell(source);
    case "code":
      return pickCode(source);
    default:
      return {};
  }
}

function pickLink(source: Properties): Properties {
  const out: Properties = {};
  const href = asString(source.href);
  if (href !== undefined && isSafeHref(href)) out.href = href;
  const title = asString(source.title);
  if (title !== undefined) out.title = title;
  return out;
}

function pickImage(source: Properties): Properties {
  const out: Properties = {};
  const src = asString(source.src);
  if (src !== undefined && isSafeImgSrc(src)) out.src = src;
  const alt = asString(source.alt);
  if (alt !== undefined) out.alt = alt;
  const title = asString(source.title);
  if (title !== undefined) out.title = title;
  return out;
}

function pickOrderedList(source: Properties): Properties {
  const out: Properties = {};
  const start = asFiniteInteger(source.start);
  if (start !== undefined) out.start = start;
  return out;
}

function pickListItem(source: Properties): Properties {
  const out: Properties = {};
  const value = asFiniteInteger(source.value);
  if (value !== undefined) out.value = String(value);
  return out;
}

function pickCell(source: Properties): Properties {
  const out: Properties = {};
  const align = asString(source.align);
  if (align !== undefined && ALIGN.has(align)) out.align = align;
  const colSpan = asSpan(source.colSpan);
  if (colSpan !== undefined) out.colSpan = colSpan;
  const rowSpan = asSpan(source.rowSpan);
  if (rowSpan !== undefined) out.rowSpan = rowSpan;
  return out;
}

function pickCode(source: Properties): Properties {
  const tokens = classTokens(source.className).filter(
    (token) => LANGUAGE_CLASS.test(token) || token === "math-inline" || token === "math-display",
  );
  if (tokens.length === 0) return {};
  return { className: tokens };
}

function pickCheckbox(source: Properties | undefined): Properties | undefined {
  const props = source ?? {};
  if (asString(props.type)?.toLowerCase() !== "checkbox") return undefined;
  const out: Properties = { type: "checkbox", disabled: true };
  if (props.checked === true || props.checked === "" || props.checked === "checked") out.checked = true;
  return out;
}

function classTokens(value: Properties[string]): string[] {
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (typeof entry === "string") return entry.split(/\s+/).filter(Boolean);
      if (typeof entry === "number") return [String(entry)];
      return [];
    });
  }
  return [];
}

function asString(value: Properties[string]): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function asFiniteInteger(value: Properties[string]): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && Number.isInteger(parsed)) return parsed;
  }
  return undefined;
}

function asSpan(value: Properties[string]): number | undefined {
  const n = asFiniteInteger(value);
  if (n === undefined || n < 1 || n > 100) return undefined;
  return n;
}

function isSafeHref(url: string): boolean {
  const lower = flattenUrl(url);
  if (!lower) return false;
  if (lower.startsWith("javascript:") || lower.startsWith("vbscript:") || lower.startsWith("data:")) return false;
  if (lower.startsWith("http:") || lower.startsWith("https:") || lower.startsWith("mailto:")) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(lower);
}

function isSafeImgSrc(url: string): boolean {
  const lower = flattenUrl(url);
  if (!lower) return false;
  if (lower.startsWith("data:image/") || lower.startsWith("blob:")) return true;
  if (lower.startsWith("javascript:") || lower.startsWith("vbscript:") || lower.startsWith("data:")) return false;
  if (lower.startsWith("http:") || lower.startsWith("https:")) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(lower);
}

function flattenUrl(url: string): string {
  return url.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
}
