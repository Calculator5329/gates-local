// Just enough DOM for react-dom/client to mount, update and unmount a tree in
// node: elements, text, attributes and inert events. No layout: every box is
// at 0,0 with no size. Tests use it to count what React mounts and subscribes,
// never to judge how anything looks.
const HTML = "http://www.w3.org/1999/xhtml";

export class FakeNode {
  parentNode: FakeNode | null = null;
  readonly childNodes: FakeNode[] = [];
  readonly nodeType: number;
  readonly nodeName: string;
  readonly ownerDocument: FakeDocument | null;
  constructor(nodeType: number, nodeName: string, ownerDocument: FakeDocument | null) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
  }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): FakeNode | null { return this.childNodes.at(-1) ?? null; }
  get nextSibling(): FakeNode | null { return this.sibling(1); }
  get previousSibling(): FakeNode | null { return this.sibling(-1); }
  private sibling(step: number): FakeNode | null {
    const p = this.parentNode;
    return p === null ? null : p.childNodes[p.childNodes.indexOf(this) + step] ?? null;
  }
  appendChild<T extends FakeNode>(child: T): T { return this.insertBefore(child, null); }
  insertBefore<T extends FakeNode>(child: T, ref: FakeNode | null): T {
    child.parentNode?.removeChild(child);
    const at = ref === null ? -1 : this.childNodes.indexOf(ref);
    if (at < 0) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild<T extends FakeNode>(child: T): T {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }
  contains(node: FakeNode | null): boolean {
    for (let n = node; n !== null; n = n.parentNode) if (n === this) return true;
    return false;
  }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(value: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes.length = 0;
    if (value !== "" && this.ownerDocument !== null) this.appendChild(this.ownerDocument.createTextNode(value));
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

export class FakeText extends FakeNode {
  nodeValue: string;
  constructor(nodeValue: string, doc: FakeDocument) {
    super(3, "#text", doc);
    this.nodeValue = nodeValue;
  }
  override get textContent(): string { return this.nodeValue; }
  override set textContent(value: string) { this.nodeValue = value; }
}

export class FakeElement extends FakeNode {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, unknown> & { setProperty(name: string, value: string): void; removeProperty(name: string): void };
  readonly dataset: Record<string, string> = {};
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  readonly namespaceURI: string;
  constructor(tag: string, namespaceURI: string, doc: FakeDocument) {
    super(1, namespaceURI === HTML ? tag.toUpperCase() : tag, doc);
    this.namespaceURI = namespaceURI;
    this.tagName = this.nodeName;
    const style: Record<string, unknown> = {};
    this.style = Object.assign(style, {
      setProperty: (name: string, value: string) => { style[name] = value; },
      removeProperty: (name: string) => { delete style[name]; },
    });
  }
  setAttribute(name: string, value: unknown): void { this.attributes.set(name, String(value)); }
  setAttributeNS(_ns: string | null, name: string, value: unknown): void { this.setAttribute(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  removeAttributeNS(_ns: string | null, name: string): void { this.removeAttribute(name); }
  get classList(): string[] { return (this.getAttribute("class") ?? "").split(/\s+/).filter((c) => c !== ""); }
  /** A test that needs positions sets this; otherwise every box is at 0,0 with no size. */
  static topOf: ((el: FakeElement) => number) | null = null;
  getBoundingClientRect() {
    const top = FakeElement.topOf?.(this) ?? 0;
    return { top, left: 0, right: 0, bottom: top, width: 0, height: 0, x: 0, y: top };
  }
  /** Class selectors only (".turn"), in document order. */
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): FakeElement[] {
    if (!/^\.[\w-]+$/.test(selector)) throw new Error(`fake-dom supports class selectors only, not ${selector}`);
    const cls = selector.slice(1);
    const out: FakeElement[] = [];
    const walk = (n: FakeNode) => {
      for (const c of n.childNodes) {
        if (c instanceof FakeElement) {
          if (c.classList.includes(cls)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  focus(): void {}
  blur(): void {}
}

/** React looks for focus inside iframes with `instanceof window.HTMLIFrameElement`; no fake element is one. */
export class FakeIFrame {
  readonly nodeName = "IFRAME";
}

export class FakeDocument extends FakeNode {
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  activeElement: FakeElement | null = null;
  defaultView: unknown = null;
  constructor() {
    super(9, "#document", null);
    this.documentElement = this.createElement("html");
    this.body = this.documentElement.appendChild(this.createElement("body"));
    this.appendChild(this.documentElement);
  }
  createElement(tag: string): FakeElement { return new FakeElement(tag, HTML, this); }
  createElementNS(ns: string, tag: string): FakeElement { return new FakeElement(tag, ns, this); }
  createTextNode(text: string): FakeText { return new FakeText(text, this); }
  getSelection(): null { return null; }
}
