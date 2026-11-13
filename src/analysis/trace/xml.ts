/**
 * Minimal, dependency-free XML reader for `xcrun xctrace export` output.
 *
 * xctrace emits a very regular subset of XML:
 *   - a `<schema>` element that lists the table columns in order, and
 *   - `<row>` elements whose direct children line up 1:1 with those columns.
 *
 * Values are deduplicated across the whole document with `id` / `ref`
 * attributes, and absent values are represented by `<sentinel/>`. This module
 * keeps just enough structure to resolve those references and read scalar
 * text; it deliberately does not attempt to be a general-purpose XML parser.
 */

export interface XmlElement {
  tag: string;
  attributes: Record<string, string>;
  /** Concatenated direct text content (child text excluded). */
  text: string;
  children: XmlElement[];
}

export interface TraceRow {
  /** Direct children in document order, before reference resolution. */
  elements: XmlElement[];
  /** Direct children with `ref` attributes resolved to their originals. */
  values: Array<XmlElement | undefined>;
}

export interface TraceTable {
  schemaName: string;
  /** Column mnemonics in schema order (`start`, `duration`, ...). */
  columns: string[];
  rows: TraceRow[];
}

const TAG_PATTERN =
  /<(\/?)([A-Za-z_][A-Za-z0-9_.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

const ATTRIBUTE_PATTERN =
  /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(input: string): string {
  if (!input.includes("&")) {
    return input;
  }
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1]?.toLowerCase() === "x";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE_PATTERN.exec(source)) !== null) {
    const value = match[2] ?? match[3] ?? "";
    attributes[match[1]] = decodeEntities(value);
  }
  return attributes;
}

function appendText(element: XmlElement, raw: string): void {
  if (raw.length > 0) {
    element.text += decodeEntities(raw);
  }
}

/**
 * Parse an XML document into a lightweight element tree. The returned root is
 * a synthetic `#document` node so callers can query uniformly.
 */
export function parseXml(source: string): XmlElement {
  const root: XmlElement = {
    tag: "#document",
    attributes: {},
    text: "",
    children: [],
  };
  const stack: XmlElement[] = [root];
  let cursor = 0;

  TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_PATTERN.exec(source)) !== null) {
    if (match.index > cursor) {
      appendText(stack[stack.length - 1], source.slice(cursor, match.index));
    }
    cursor = TAG_PATTERN.lastIndex;

    const [, closing, tag, attributeSource, selfClosing] = match;
    if (closing === "/") {
      // Pop through the matching open tag. Well-formed xctrace output closes
      // in order; the loop is defensive against stray close tags.
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tag === tag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }

    const element: XmlElement = {
      tag,
      attributes: parseAttributes(attributeSource),
      text: "",
      children: [],
    };
    stack[stack.length - 1].children.push(element);
    if (selfClosing !== "/") {
      stack.push(element);
    }
  }

  if (cursor < source.length) {
    appendText(stack[stack.length - 1], source.slice(cursor));
  }
  return root;
}

export function findFirst(root: XmlElement, tag: string): XmlElement | undefined {
  if (root.tag === tag) {
    return root;
  }
  for (const child of root.children) {
    const found = findFirst(child, tag);
    if (found) {
      return found;
    }
  }
  return undefined;
}

export function collectElements(root: XmlElement, tag: string): XmlElement[] {
  const found: XmlElement[] = [];
  const visit = (element: XmlElement): void => {
    if (element.tag === tag) {
      found.push(element);
    }
    for (const child of element.children) {
      visit(child);
    }
  };
  visit(root);
  return found;
}

/**
 * Build a document-wide `id -> element` index. xctrace ids are unique across
 * the whole export, including elements nested inside `<narrative>` and
 * `<tagged-backtrace>`, so a single map is correct and keeps reference
 * resolution order-independent.
 */
export function indexElementIds(root: XmlElement): Map<string, XmlElement> {
  const ids = new Map<string, XmlElement>();
  const visit = (element: XmlElement): void => {
    const id = element.attributes.id;
    if (id !== undefined) {
      ids.set(id, element);
    }
    for (const child of element.children) {
      visit(child);
    }
  };
  visit(root);
  return ids;
}

/** Follow a chain of `ref` attributes to the element that owns the value. */
export function resolveElement(
  element: XmlElement | undefined,
  ids: Map<string, XmlElement>,
): XmlElement | undefined {
  let current = element;
  for (let depth = 0; current && "ref" in current.attributes && depth < 16; depth += 1) {
    current = ids.get(current.attributes.ref);
  }
  return current;
}

/** Resolved direct text, or `undefined` for `<sentinel/>` and empty values. */
export function elementText(element: XmlElement | undefined): string | undefined {
  if (!element || element.tag === "sentinel") {
    return undefined;
  }
  const text = element.text.trim();
  return text.length > 0 ? text : undefined;
}

/** Resolved display attribute (`fmt`), used for process names and sizes. */
export function elementFmt(element: XmlElement | undefined): string | undefined {
  if (!element || element.tag === "sentinel") {
    return undefined;
  }
  const fmt = element.attributes.fmt?.trim();
  return fmt && fmt.length > 0 ? fmt : undefined;
}

/**
 * Parse the `<schema>` header plus every `<row>` of a trace table export.
 * Column values are matched positionally, which is how xctrace encodes tables.
 */
export function parseTraceTable(xml: string): TraceTable {
  const document = parseXml(xml);
  const schema = findFirst(document, "schema");
  const columns = schema
    ? schema.children
        .filter((child) => child.tag === "col")
        .map(
          (col) =>
            col.children.find((child) => child.tag === "mnemonic")?.text.trim() ??
            col.attributes.mnemonic ??
            "",
        )
        .filter((name) => name.length > 0)
    : [];

  const ids = indexElementIds(document);
  const rows = collectElements(document, "row").map((row) => ({
    elements: row.children,
    values: row.children.map((child) => resolveElement(child, ids)),
  }));

  return {
    schemaName: schema?.attributes.name ?? "",
    columns,
    rows,
  };
}

/** Positional column lookup; returns `undefined` when the schema lacks it. */
export function columnValue(
  table: TraceTable,
  row: TraceRow,
  mnemonic: string,
): XmlElement | undefined {
  const index = table.columns.indexOf(mnemonic);
  return index >= 0 ? row.values[index] : undefined;
}

export function columnText(
  table: TraceTable,
  row: TraceRow,
  mnemonic: string,
): string | undefined {
  return elementText(columnValue(table, row, mnemonic));
}

export function columnNumber(
  table: TraceTable,
  row: TraceRow,
  mnemonic: string,
): number | undefined {
  const text = columnText(table, row, mnemonic);
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

export function columnInteger(
  table: TraceTable,
  row: TraceRow,
  mnemonic: string,
): number | undefined {
  const value = columnNumber(table, row, mnemonic);
  return value === undefined ? undefined : Math.trunc(value);
}

export function columnFmt(
  table: TraceTable,
  row: TraceRow,
  mnemonic: string,
): string | undefined {
  return elementFmt(columnValue(table, row, mnemonic));
}
