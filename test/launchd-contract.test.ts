/**
 * test/launchd-contract.test.ts — checked-in launchd/*.plist contract (OPS-05 /
 * OPS-07). Each plist is read with the platform-independent parser below rather
 * than Apple's `plutil -lint`, so the same assertions run on macOS and on Linux
 * CI; scheduling (KeepAlive / StartInterval) and the pull job's arguments are
 * asserted on the parsed values, not on substrings of the file. On macOS
 * `plutil` is additionally required to agree with the parser. Nothing is
 * loaded, unloaded, or written to ~/Library.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LAUNCHD = join(import.meta.dir, "../launchd");
const JOBS = ["ingest", "maintenance", "pull", "web", "orchestrator"];
const PLUTIL = "/usr/bin/plutil";

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };
type Tag = { name: string; kind: "open" | "close" | "empty"; attrs: Record<string, string> };

class PlistError extends Error {}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * Reader for the XML-plist subset launchd files use. It rejects what
 * `plutil -lint` rejects: an unbalanced or unknown tag, a <key> with no value,
 * a duplicate key, a non-numeric <integer>, content inside <true/>, stray text
 * between elements, an unescaped `&`, anything after </plist>. It is not a
 * general XML parser — no namespaces, CDATA, or `>` inside an attribute value,
 * none of which occur in a plist. <data> and <date> are validated and returned
 * as their raw strings, since no Overload job uses either.
 */
class PlistReader {
  private i = 0;
  constructor(private readonly src: string) {}

  document(): PlistValue {
    const root = this.tag();
    if (root.name !== "plist" || root.kind !== "open") this.fail("root element must be <plist>");
    if (root.attrs.version !== "1.0") this.fail(`unsupported plist version ${root.attrs.version ?? "(missing)"}`);
    const value = this.value(this.tag());
    const close = this.tag();
    if (close.kind !== "close" || close.name !== "plist") this.fail("expected </plist>");
    this.trivia();
    if (this.i < this.src.length) this.fail("trailing content after </plist>");
    return value;
  }

  private fail(message: string): never {
    throw new PlistError(`${message} (line ${this.src.slice(0, this.i).split("\n").length})`);
  }

  /** Whitespace, comments, the XML declaration and the DOCTYPE carry no value. */
  private trivia(): void {
    for (;;) {
      while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) this.i++;
      const skip = (open: string, close: string): boolean => {
        if (!this.src.startsWith(open, this.i)) return false;
        const end = this.src.indexOf(close, this.i + open.length);
        if (end < 0) this.fail(`unterminated ${open}`);
        this.i = end + close.length;
        return true;
      };
      if (skip("<!--", "-->") || skip("<?", "?>") || skip("<!DOCTYPE", ">")) continue;
      return;
    }
  }

  private tag(): Tag {
    this.trivia();
    if (this.src[this.i] !== "<") this.fail(this.i >= this.src.length ? "unexpected end of document" : "expected a tag");
    const end = this.src.indexOf(">", this.i);
    if (end < 0) this.fail("unterminated tag");
    let body = this.src.slice(this.i + 1, end);
    this.i = end + 1;
    const kind = body.startsWith("/") ? "close" : body.endsWith("/") ? "empty" : "open";
    body = kind === "close" ? body.slice(1) : kind === "empty" ? body.slice(0, -1) : body;
    const head = /^([A-Za-z_][\w.-]*)\s*/.exec(body);
    if (!head) this.fail(`malformed tag <${body}>`);
    const attrs: Record<string, string> = {};
    for (let rest = body.slice(head[0].length); rest.trim(); ) {
      const attr = /^([A-Za-z_][\w.-]*)="([^"]*)"\s*/.exec(rest);
      if (!attr) this.fail(`malformed attribute in <${head[1]}>`);
      attrs[attr[1]!] = attr[2]!;
      rest = rest.slice(attr[0].length);
    }
    if (kind === "close" && Object.keys(attrs).length > 0) this.fail(`</${head[1]}> takes no attributes`);
    return { name: head[1]!, kind, attrs };
  }

  /** Text content of the element just opened, up to its closing tag. */
  private scalar(name: string): string {
    const end = this.src.indexOf("<", this.i);
    if (end < 0) this.fail(`unterminated <${name}>`);
    const raw = this.src.slice(this.i, end);
    this.i = end;
    const close = this.tag();
    if (close.kind !== "close" || close.name !== name) this.fail(`expected </${name}>`);
    return this.decode(raw, name);
  }

  private decode(raw: string, where: string): string {
    let out = "";
    for (let i = 0; i < raw.length; ) {
      if (raw[i] !== "&") { out += raw[i]; i++; continue; }
      const end = raw.indexOf(";", i);
      const body = end < 0 ? "" : raw.slice(i + 1, end);
      if (!/^(#[0-9]+|#x[0-9A-Fa-f]+|[a-z]+)$/.test(body)) this.fail(`unescaped & in <${where}>`);
      if (body.startsWith("#")) out += String.fromCodePoint(Number(body.startsWith("#x") ? `0x${body.slice(2)}` : body.slice(1)));
      else {
        const entity = ENTITIES[body];
        if (entity === undefined) this.fail(`unknown entity &${body}; in <${where}>`);
        out += entity;
      }
      i = end + 1;
    }
    return out;
  }

  private value(open: Tag): PlistValue {
    if (open.kind === "close") this.fail(`unexpected </${open.name}>`);
    switch (open.name) {
      case "true":
      case "false":
        if (open.kind !== "empty") this.fail(`<${open.name}> must be an empty element`);
        return open.name === "true";
      case "string":
        return open.kind === "empty" ? "" : this.scalar("string");
      case "integer":
      case "real": {
        if (open.kind === "empty") this.fail(`<${open.name}> has no value`);
        const raw = this.scalar(open.name).trim();
        const shape = open.name === "integer" ? /^-?\d+$/ : /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
        if (!shape.test(raw)) this.fail(`<${open.name}> is not a number: ${JSON.stringify(raw)}`);
        return Number(raw);
      }
      case "data":
      case "date": {
        if (open.kind === "empty") this.fail(`<${open.name}> has no value`);
        const raw = this.scalar(open.name).trim();
        const shape = open.name === "data" ? /^[A-Za-z0-9+/\s]*={0,2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
        if (!shape.test(raw)) this.fail(`<${open.name}> is malformed: ${JSON.stringify(raw)}`);
        return raw;
      }
      case "dict": {
        const dict: Record<string, PlistValue> = {};
        if (open.kind === "empty") return dict;
        for (;;) {
          const next = this.tag();
          if (next.kind === "close" && next.name === "dict") return dict;
          if (next.name !== "key" || next.kind !== "open") this.fail(`expected <key> in <dict>, found <${next.name}>`);
          const key = this.scalar("key");
          if (!key) this.fail("empty <key> in <dict>");
          if (key in dict) this.fail(`duplicate key ${key}`);
          const value = this.tag();
          if (value.kind === "close") this.fail(`<key>${key}</key> has no value`);
          dict[key] = this.value(value);
        }
      }
      case "array": {
        const array: PlistValue[] = [];
        if (open.kind === "empty") return array;
        for (;;) {
          const next = this.tag();
          if (next.kind === "close" && next.name === "array") return array;
          array.push(this.value(next));
        }
      }
      default:
        this.fail(`unknown plist element <${open.name}>`);
    }
  }
}

function parsePlist(source: string): PlistValue {
  return new PlistReader(source).document();
}

function plist(name: string): string {
  return readFileSync(join(LAUNCHD, `app.overload.${name}.plist`), "utf8");
}

/** The parsed job dictionary; fails the test if the root value is not a dict. */
function job(name: string): Record<string, PlistValue> {
  const root = parsePlist(plist(name));
  if (typeof root !== "object" || root === null || Array.isArray(root)) throw new PlistError(`${name}.plist root is not a <dict>`);
  return root;
}

function args(name: string): PlistValue[] {
  const value = job(name).ProgramArguments;
  if (!Array.isArray(value)) throw new PlistError(`${name}.plist ProgramArguments is not an <array>`);
  return value;
}

describe("plist parse + scheduling (OPS-05)", () => {
  for (const name of JOBS) {
    test(`${name}.plist parses and is labelled app.overload.${name}`, () => {
      const parsed = job(name);
      expect(parsed.Label).toBe(`app.overload.${name}`);
      expect(parsed.ProcessType).toBe("Background");
      expect(args(name).length).toBeGreaterThan(0);
      for (const arg of args(name)) expect(typeof arg).toBe("string");
    });
  }

  // Without this, "parses OK" above would also pass for a parser that accepted
  // anything. Each case is rejected by `plutil -lint` too.
  test("the parser rejects malformed plists", () => {
    const wrap = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">${body}</plist>`;
    const bad: Record<string, string> = {
      "unclosed dict": wrap("<dict><key>A</key><string>a</string>"),
      "mismatched close": wrap("<dict><key>A</key><string>a</array></dict>"),
      "key without value": wrap("<dict><key>A</key></dict>"),
      "value without key": wrap("<dict><string>a</string></dict>"),
      "duplicate key": wrap("<dict><key>A</key><true/><key>A</key><false/></dict>"),
      "non-numeric integer": wrap("<dict><key>A</key><integer>sixty</integer></dict>"),
      "content in true": wrap("<dict><key>A</key><true>yes</true></dict>"),
      "unknown element": wrap("<dict><key>A</key><duration>60</duration></dict>"),
      "stray text in dict": wrap("<dict>oops<key>A</key><true/></dict>"),
      "unescaped ampersand": wrap("<dict><key>A</key><string>a & b</string></dict>"),
      "trailing content": `${wrap("<dict/>")}<dict/>`,
      "wrong root": '<?xml version="1.0"?><dict/>',
      "wrong version": '<?xml version="1.0"?><plist version="2.0"><dict/></plist>',
    };
    for (const [why, source] of Object.entries(bad)) {
      expect(() => parsePlist(source), why).toThrow(PlistError);
    }
    // ...and accepts the shape the real files use, including a comment and DOCTYPE.
    expect(parsePlist(plist("ingest"))).toBeTypeOf("object");
  });

  test("ingest and web are KeepAlive; maintenance and pull run every 60s", () => {
    expect(job("ingest").KeepAlive).toBe(true);
    expect(job("web").KeepAlive).toBe(true);
    expect(job("ingest").StartInterval).toBeUndefined();
    expect(job("maintenance").StartInterval).toBe(60);
    expect(job("pull").StartInterval).toBe(60);
    for (const name of JOBS) expect(job(name).RunAtLoad).toBe(true);
  });

  test("retired notifier plist is gone", () => {
    expect(existsSync(join(LAUNCHD, "app.overload.notifier.plist"))).toBe(false);
  });

  // Apple's own linter stays authoritative where it exists; the assertions
  // above are the coverage everywhere else.
  test.skipIf(!existsSync(PLUTIL))("plutil agrees that every plist lints (macOS only)", async () => {
    for (const name of JOBS) {
      const proc = Bun.spawn([PLUTIL, "-lint", join(LAUNCHD, `app.overload.${name}.plist`)], { stdout: "pipe", stderr: "pipe" });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect({ name, exitCode, stderr }).toMatchObject({ name, exitCode: 0, stderr: "" });
    }
  });
});

describe("pull job contract (OPS-07)", () => {
  test("pull.plist runs bun src/pull/pull.ts --once", () => {
    const command = args("pull").join(" ");
    expect(command).toContain("src/pull/pull.ts");
    expect(command).toContain("--once");
    expect(job("pull").StartInterval).toBe(60);
  });

  test("README documents pull in both install and uninstall sections", () => {
    const readme = readFileSync(join(LAUNCHD, "README.md"), "utf8");
    const uninstall = readme.indexOf("# Uninstall");
    expect(uninstall).toBeGreaterThanOrEqual(0);
    const installBlock = readme.slice(0, uninstall);
    expect(readme).toContain("pull");
    expect(installBlock).toContain("pull");
  });
});
