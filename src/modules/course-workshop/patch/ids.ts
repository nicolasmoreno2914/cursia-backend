/**
 * r107 B4 · motor de parches — ids nuevos (CLAUDE.md «Convenciones de ids»): enteros incrementales ÚNICOS en TODO el
 * paquete. Se escanea el máximo de todos los XML (atributos `id="N"` y elementos `<…id>N</…id>`); los `sco` / `sco_data`
 * de los SCORM viven en su rango propio (60000+) y NO suben el máximo general, pero un id nuevo nunca repite ninguno
 * existente (tampoco uno de ese rango).
 */
import { PatchState } from './container';

const ATTR = /\bid="(\d{1,15})"/g;
const ELEM = /<([a-z_]*id)>(\d{1,15})<\/\1>/g;
const SCO = /<(sco|sco_data|sco_track|seq_[a-z_]+)\s+id="(\d{1,15})"/g;

export class IdAllocator {
  private next: number;
  private readonly used: Set<number>;
  readonly assigned: Record<string, number[]> = {};

  private constructor(maxGeneral: number, used: Set<number>) {
    this.next = maxGeneral + 1;
    this.used = used;
  }

  static async scan(state: PatchState): Promise<IdAllocator> {
    const used = new Set<number>();
    const sco = new Set<number>();
    for (const n of state.names()) {
      if (!/\.xml$/i.test(n)) continue;
      const x = await state.readText(n);
      for (const m of x.matchAll(SCO)) sco.add(Number(m[2]));
      for (const m of x.matchAll(ATTR)) used.add(Number(m[1]));
      for (const m of x.matchAll(ELEM)) used.add(Number(m[2]));
    }
    let max = 0;
    for (const v of used) if (!sco.has(v) && v > max) max = v;
    for (const v of sco) used.add(v);
    return new IdAllocator(max, used);
  }

  /** Id nuevo para `kind` (solo para el informe: el espacio es uno solo). */
  take(kind: string): number {
    while (this.used.has(this.next)) this.next++;
    const v = this.next++;
    this.used.add(v);
    (this.assigned[kind] ||= []).push(v);
    return v;
  }
}
