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
  private nextSco: number;
  private readonly used: Set<number>;
  readonly assigned: Record<string, number[]> = {};

  private constructor(maxGeneral: number, used: Set<number>, maxSco: number) {
    this.next = maxGeneral + 1;
    this.used = used;
    // r107 B11 (P2-6): los sco arrancan sobre max(general escaneado, sco / sco_data, 60000): nunca chocan con el espacio
    // general (los dos comparten `used`) y siempre quedan en su rango.
    this.nextSco = Math.max(maxGeneral, maxSco, 59_999) + 1;
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
    // Ronda 4 (M-P2-1): los ids que viven solo en atributos (`contextid="N"`, `moduleid="N"`, `instanceid` / `contextinstanceid`)
    // se reservan SIEMPRE en el escaneo (antes lo hacía cada operación, después de haber tomado ids): nunca se repiten. No
    // suben el máximo general (los ids que ya asignaban las demás operaciones no cambian).
    for (const n of state.names()) {
      if (!/\.xml$/i.test(n)) continue;
      const x = await state.readText(n);
      for (const m of x.matchAll(/\b(?:contextid|moduleid|instanceid|contextinstanceid)="(\d{1,15})"/g)) used.add(Number(m[1]));
    }
    return new IdAllocator(max, used, Math.max(0, ...sco));
  }

  /** r107 B11: marca como usados ids que el escaneo general no ve (atributos `contextid="N"` / `moduleid="N"`). */
  reserve(ids: Iterable<number>): void {
    for (const v of ids) this.used.add(v);
  }

  /** Id nuevo de `sco` / `sco_data` (rango propio 60000+, sin repetir NINGÚN id del paquete ni de este asignador). */
  takeSco(kind = 'sco'): number {
    while (this.used.has(this.nextSco)) this.nextSco++;
    const v = this.nextSco++;
    this.used.add(v);
    (this.assigned[kind] ||= []).push(v);
    return v;
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
