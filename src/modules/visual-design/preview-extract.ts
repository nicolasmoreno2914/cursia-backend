/**
 * r76 «Diseño visual» — lee del .mbz YA ARMADO el HTML de cada actividad (label / page / resource / quiz / scorm) y sus
 * archivos (files.xml + files/<hh>/<sha1>). Es lo que Moodle restaura: la vista previa muestra exactamente esos bytes.
 *
 * `xmlUnescape` es la inversa exacta de `xmlEsc` de los builders (& < > " — sin apóstrofes, ver CLAUDE.md).
 */
import * as JSZip from 'jszip';

export interface MbzActivityHtml {
  moduleId: number;
  modname: string;
  idnumber: string;
  name: string;
  contextId: number;
  /** HTML tal cual quedó en el .mbz (intro del label/resource/quiz/scorm o content de la page), ya des-escapado del XML. */
  html: string;
  /** Archivos del contexto de la actividad: filename → { mime, sha1, bytes }. */
  files: Map<string, { mime: string; sha1: string; bytes: Buffer }>;
}

export function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : null;
};

/** Todas las actividades del paquete con su HTML y archivos, en el orden de moodle_backup.xml. */
export async function readMbzActivities(mbz: Buffer): Promise<MbzActivityHtml[]> {
  const zip = await JSZip.loadAsync(mbz);
  const read = async (p: string): Promise<string | null> => {
    const f = zip.file(p);
    return f ? f.async('string') : null;
  };
  const backup = (await read('moodle_backup.xml')) ?? '';
  const filesXml = (await read('files.xml')) ?? '';
  const byContext = new Map<number, Array<{ filename: string; mime: string; sha1: string }>>();
  for (const m of filesXml.matchAll(/<file id="\d+">([\s\S]*?)<\/file>/g)) {
    const f = m[1];
    const filename = xmlUnescape(tag(f, 'filename') ?? '');
    if (!filename || filename === '.') continue;
    const ctx = Number(tag(f, 'contextid'));
    const list = byContext.get(ctx) ?? [];
    list.push({ filename, mime: tag(f, 'mimetype') ?? 'application/octet-stream', sha1: tag(f, 'contenthash') ?? '' });
    byContext.set(ctx, list);
  }
  const out: MbzActivityHtml[] = [];
  for (const a of backup.matchAll(/<activity>([\s\S]*?)<\/activity>/g)) {
    const dir = tag(a[1], 'directory');
    const modname = tag(a[1], 'modulename') ?? '';
    if (!dir || !modname) continue;
    const modXml = (await read(`${dir}/${modname}.xml`)) ?? '';
    const moduleXml = (await read(`${dir}/module.xml`)) ?? '';
    const ctx = Number((/<activity [^>]*contextid="(\d+)"/.exec(modXml) || [])[1]);
    const raw = modname === 'page' ? tag(modXml, 'content') : tag(modXml, 'intro');
    const files = new Map<string, { mime: string; sha1: string; bytes: Buffer }>();
    for (const f of byContext.get(ctx) ?? []) {
      const blob = zip.file(`files/${f.sha1.slice(0, 2)}/${f.sha1}`);
      if (blob) files.set(f.filename, { mime: f.mime, sha1: f.sha1, bytes: await blob.async('nodebuffer') });
    }
    out.push({
      moduleId: Number(tag(a[1], 'moduleid')),
      modname,
      idnumber: xmlUnescape(tag(moduleXml, 'idnumber') ?? ''),
      name: xmlUnescape(tag(modXml, 'name') ?? tag(a[1], 'title') ?? ''),
      contextId: ctx,
      html: xmlUnescape(raw ?? ''),
      files,
    });
  }
  return out;
}

/**
 * HTML para MOSTRAR fuera de Moodle: cada `@@PLUGINFILE@@/<archivo>` del contexto pasa a data URI (imágenes) y los demás
 * (PDF, MP3) a `#` — un iframe con sandbox no puede abrir la URL de Moodle. Los tokens `$@…@$` quedan como `#`.
 * Solo cambia ATRIBUTOS src/href; el resto del HTML (estilos, estructura, texto) es byte a byte el del paquete.
 */
export function displayableHtml(a: Pick<MbzActivityHtml, 'html' | 'files'>): string {
  return a.html
    .replace(/(src|href)="@@PLUGINFILE@@\/([^"]+)"/g, (_m, attr: string, name: string) => {
      const f = a.files.get(decodeURIComponent(name));
      if (f && /^image\/(png|jpeg|gif)$/.test(f.mime)) return `${attr}="data:${f.mime};base64,${f.bytes.toString('base64')}"`;
      return `${attr}="#"`;
    })
    .replace(/(src|href)="(\$@[A-Z]+\*?\d*@\$|cursia-cta:\/\/[^"]*)"/g, (_m, attr: string) => `${attr}="#"`);
}

/** Los colores hex y las pilas `font-family` de los estilos inline: la «firma» visual de un HTML (paridad de tema). */
export function inlineStyleSignature(html: string): { colors: string[]; fonts: string[] } {
  const colors = new Set<string>();
  const fonts = new Set<string>();
  for (const m of html.matchAll(/style="([^"]*)"/g)) {
    const style = m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    for (const c of style.matchAll(/#[0-9A-Fa-f]{6}\b/g)) colors.add(c[0].toUpperCase());
    for (const f of style.matchAll(/font-family:([^;]+)/g)) fonts.add(f[1].trim());
  }
  return { colors: [...colors].sort(), fonts: [...fonts].sort() };
}
