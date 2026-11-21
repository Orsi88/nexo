// Leitor de XML mínimo, suficiente para relatórios JUnit: elementos, atributos, texto, CDATA,
// comentários e as entidades padrão. Por segurança, não processa DOCTYPE nem entidades
// declaradas (sem XXE, sem "billion laughs") e tem limite de elementos.

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlParseError";
  }
}

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref.startsWith("#x")) return safeChar(parseInt(ref.slice(2), 16)) ?? whole;
    if (ref.startsWith("#")) return safeChar(parseInt(ref.slice(1), 10)) ?? whole;
    return NAMED[ref] ?? whole;
  });
}

function safeChar(code: number): string | undefined {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
}

const NAME = /[A-Za-z_:][\w.:-]*/y;
const ATTR = /\s*([A-Za-z_:][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/y;

export function parseXml(source: string, maxElements = 200_000): XmlElement {
  let i = 0;
  let count = 0;
  const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  const top = () => stack[stack.length - 1]!;

  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) {
      top().text += decode(source.slice(i));
      break;
    }
    if (lt > i) top().text += decode(source.slice(i, lt));
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      if (end === -1) throw new XmlParseError("comentário sem fim");
      i = end + 3;
    } else if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      if (end === -1) throw new XmlParseError("CDATA sem fim");
      top().text += source.slice(lt + 9, end);
      i = end + 3;
    } else if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt + 2);
      if (end === -1) throw new XmlParseError("instrução sem fim");
      i = end + 2;
    } else if (source.startsWith("<!", lt)) {
      // DOCTYPE e declarações: recusados (relatório JUnit não precisa, e evita entidades externas).
      throw new XmlParseError("DOCTYPE não é aceito em relatórios");
    } else if (source.startsWith("</", lt)) {
      NAME.lastIndex = lt + 2;
      const m = NAME.exec(source);
      if (!m) throw new XmlParseError("fechamento inválido");
      const close = source.indexOf(">", NAME.lastIndex);
      if (close === -1) throw new XmlParseError("fechamento sem >");
      const open = stack.pop();
      if (!open || open.name !== m[0] || stack.length === 0) throw new XmlParseError(`fechamento inesperado: ${m[0]}`);
      i = close + 1;
    } else {
      NAME.lastIndex = lt + 1;
      const m = NAME.exec(source);
      if (!m) throw new XmlParseError("elemento inválido");
      const el: XmlElement = { name: m[0], attrs: {}, children: [], text: "" };
      let j = NAME.lastIndex;
      for (;;) {
        ATTR.lastIndex = j;
        const a = ATTR.exec(source);
        if (!a) break;
        el.attrs[a[1]!] = decode(a[3] ?? a[4] ?? "");
        j = ATTR.lastIndex;
      }
      while (j < source.length && /\s/.test(source[j]!)) j++;
      const selfClosing = source.startsWith("/>", j);
      if (!selfClosing && source[j] !== ">") throw new XmlParseError(`elemento malformado: ${el.name}`);
      if (++count > maxElements) throw new XmlParseError("relatório grande demais");
      top().children.push(el);
      if (!selfClosing) stack.push(el);
      i = j + (selfClosing ? 2 : 1);
    }
  }
  if (stack.length !== 1) throw new XmlParseError(`elemento sem fechamento: ${top().name}`);
  const element = root.children[0];
  if (!element) throw new XmlParseError("documento vazio");
  return element;
}
