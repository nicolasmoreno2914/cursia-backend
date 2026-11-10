/**
 * r107 B4 · `edit_html` — reemplaza el HTML de UN campo (intro de una etiqueta, contenido de una página, descripción de
 * una actividad, capítulo de un book, resumen de una sección): completo, por rango de bytes del crudo (`dead_link`) o
 * sobre un token exacto (quitar el enlace / cambiar el destino). Mismo moduleid, misma entrada: solo cambian los bytes
 * del campo.
 */
import { pluginfileRefs } from '../course-model';
import { sha1Of } from './container';
import { FieldEditResult, editToken, findField, locateField, replaceAll, replaceRange, validateNewHtml, writeField } from './html-edit';
import { OpContext, noteModified } from './op-context';
import { EditHtmlOp, PatchError } from './types';

export async function applyEditHtml(ctx: OpContext, op: EditHtmlOp): Promise<void> {
  const t = findField(ctx.inv, op.target as { moduleId?: number; sectionId?: number; field?: string });
  if (op.expectRawSha1 && op.expectRawSha1 !== t.field.rawSha1) {
    throw new PatchError('stale_target', `El campo ${t.where} cambió desde que se armó el plan (sha1 ${t.field.rawSha1.slice(0, 10)}… ≠ ${op.expectRawSha1.slice(0, 10)}…).`);
  }
  const loc = await locateField(ctx.state, t.field);
  const c = op.change;
  if (!c || typeof c !== 'object') throw new PatchError('invalid_params', 'Falta el cambio (`change`).');
  let res: FieldEditResult;
  if (c.kind === 'replace') {
    if (typeof c.html !== 'string') throw new PatchError('invalid_params', 'replace sin html.');
    res = replaceAll(c.html);
  } else if (c.kind === 'range') {
    if (typeof c.html !== 'string') throw new PatchError('invalid_params', 'range sin html.');
    res = replaceRange(loc.raw, c.rawByteOffset, c.rawBytes, c.html);
  } else if (c.kind === 'token') {
    res = editToken(loc.raw, c.token, c.action, c.action === 'retarget' ? c.to : undefined);
  } else {
    throw new PatchError('invalid_params', `Cambio desconocido: ${(c as { kind?: string }).kind}.`);
  }
  validateNewHtml(res.fragment, res.newHtml, { tokenCtx: ctx.tokenCtx, oldHtml: t.field.html, files: (t.activity?.files ?? []).map((f) => f.filename), where: t.where });
  if (res.newRaw === loc.raw) throw new PatchError('invalid_params', `El cambio no modifica ${t.where} (mismo contenido).`);
  writeField(ctx.state, loc, res.newRaw);
  noteModified(ctx, loc.entry);
  ctx.report.fields.push({
    entry: loc.entry, field: t.field.field, moduleId: t.activity?.moduleId ?? null, sectionId: t.sectionId,
    before: t.field.html, after: res.newHtml, beforeRawSha1: t.field.rawSha1, afterRawSha1: sha1Of(res.newRaw),
  });
  ctx.report.notes.push(...res.notes);
  const gone = pluginfileRefs(t.field.html).filter((f) => !pluginfileRefs(res.newHtml).includes(f));
  if (gone.length) ctx.report.notes.push(`el campo ya no usa ${gone.join(', ')} (el archivo queda en el paquete)`);
  ctx.report.summary = `${t.activity ? `${t.activity.title || t.activity.dir}` : t.where} — ${t.field.field}: ${c.kind === 'replace' ? 'HTML reemplazado' : c.kind === 'range' ? 'fragmento reemplazado' : c.action === 'unlink' ? 'enlace quitado' : 'destino del enlace cambiado'}`;
}
