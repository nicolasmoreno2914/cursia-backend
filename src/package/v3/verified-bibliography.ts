/**
 * R14 (QA factual) — bibliografía VERIFICADA del Libro Guía.
 *
 * El LLM genera la bibliografía de las intros sin poder verificarla: en el showcase aparecieron
 * referencias inventadas ("Suárez 2022, MinTIC…"), títulos mal atribuidos (Selwyn 2019 en una
 * revista) y autores mal escritos ("Cowley" por Cowls). Una referencia falsa enseña algo falso.
 *
 * Regla al empaquetar (determinista, sin regenerar): una entrada se publica SOLO si corresponde a
 * una obra de este catálogo — mismo primer apellido, mismo año y título equivalente — y se publica
 * en su forma CANÓNICA (corrige erratas de autor/título). Lo demás se omite: preferimos una
 * bibliografía más corta a una con obras que no existen.
 */
import type { BibliographyEntry } from '../../modules/course-shell/intro-schemas';

export interface VerifiedWork {
  author: string;
  year: number;
  title: string;
  publisher: string;
}

/** Obras verificadas (educación, evaluación, diseño instruccional, IA y educación). */
export const VERIFIED_BIBLIOGRAPHY: readonly VerifiedWork[] = [
  { author: 'Hattie, John', year: 2009, title: 'Visible Learning: A Synthesis of Over 800 Meta-Analyses Relating to Achievement', publisher: 'Routledge' },
  { author: 'Hattie, John y Timperley, Helen', year: 2007, title: 'The Power of Feedback', publisher: 'Review of Educational Research, 77(1)' },
  { author: 'Wiggins, Grant y McTighe, Jay', year: 2005, title: 'Understanding by Design (2.ª ed.)', publisher: 'ASCD' },
  { author: 'Wiggins, Grant', year: 1998, title: 'Educative Assessment: Designing Assessments to Inform and Improve Student Performance', publisher: 'Jossey-Bass' },
  { author: 'Biggs, John y Tang, Catherine', year: 2011, title: 'Teaching for Quality Learning at University: What the Student Does (4.ª ed.)', publisher: 'Open University Press' },
  { author: 'Bransford, John D., Brown, Ann L. y Cocking, Rodney R.', year: 2000, title: 'How People Learn: Brain, Mind, Experience, and School', publisher: 'National Academy Press' },
  { author: 'Black, Paul y Wiliam, Dylan', year: 1998, title: 'Assessment and Classroom Learning', publisher: 'Assessment in Education: Principles, Policy & Practice, 5(1)' },
  { author: 'Wiliam, Dylan', year: 2011, title: 'Embedded Formative Assessment', publisher: 'Solution Tree Press' },
  { author: 'Shute, Valerie J.', year: 2008, title: 'Focus on Formative Feedback', publisher: 'Review of Educational Research, 78(1)' },
  { author: 'Nicol, David J. y Macfarlane-Dick, Debra', year: 2006, title: 'Formative Assessment and Self-Regulated Learning: A Model and Seven Principles of Good Feedback Practice', publisher: 'Studies in Higher Education, 31(2)' },
  { author: 'Anderson, Lorin W. y Krathwohl, David R. (Eds.)', year: 2001, title: "A Taxonomy for Learning, Teaching, and Assessing: A Revision of Bloom's Taxonomy of Educational Objectives", publisher: 'Longman' },
  { author: 'Bloom, Benjamin S. (Ed.)', year: 1956, title: 'Taxonomy of Educational Objectives: The Classification of Educational Goals. Handbook I: Cognitive Domain', publisher: 'David McKay' },
  { author: 'Brookfield, Stephen D. y Preskill, Stephen', year: 2005, title: 'Discussion as a Way of Teaching: Tools and Techniques for Democratic Classrooms (2.ª ed.)', publisher: 'Jossey-Bass' },
  { author: 'Garrison, D. Randy y Vaughan, Norman D.', year: 2008, title: 'Blended Learning in Higher Education: Framework, Principles, and Guidelines', publisher: 'Jossey-Bass' },
  { author: 'Bates, A. W. (Tony)', year: 2015, title: 'Teaching in a Digital Age: Guidelines for Designing Teaching and Learning', publisher: 'Tony Bates Associates' },
  { author: 'Bates, A. W. (Tony)', year: 2019, title: 'Teaching in a Digital Age: Guidelines for Designing Teaching and Learning (2.ª ed.)', publisher: 'Tony Bates Associates Ltd.' },
  { author: 'Mayer, Richard E.', year: 2009, title: 'Multimedia Learning (2.ª ed.)', publisher: 'Cambridge University Press' },
  { author: 'Mishra, Punya y Koehler, Matthew J.', year: 2006, title: 'Technological Pedagogical Content Knowledge: A Framework for Teacher Knowledge', publisher: 'Teachers College Record, 108(6)' },
  { author: 'Rose, David H. y Meyer, Anne', year: 2002, title: 'Teaching Every Student in the Digital Age: Universal Design for Learning', publisher: 'ASCD' },
  { author: 'Kolb, David A.', year: 1984, title: 'Experiential Learning: Experience as the Source of Learning and Development', publisher: 'Prentice Hall' },
  { author: 'Selwyn, Neil', year: 2019, title: 'Should Robots Replace Teachers? AI and the Future of Education', publisher: 'Polity Press' },
  { author: 'Holmes, Wayne, Bialik, Maya y Fadel, Charles', year: 2019, title: 'Artificial Intelligence in Education: Promises and Implications for Teaching and Learning', publisher: 'Center for Curriculum Redesign' },
  { author: 'Luckin, Rose', year: 2018, title: 'Machine Learning and Human Intelligence: The Future of Education for the 21st Century', publisher: 'UCL IOE Press' },
  { author: 'Floridi, Luciano y Cowls, Josh', year: 2019, title: 'A Unified Framework of Five Principles for AI in Society', publisher: 'Harvard Data Science Review, 1(1)' },
  { author: 'Brynjolfsson, Erik y McAfee, Andrew', year: 2017, title: 'Machine, Platform, Crowd: Harnessing Our Digital Future', publisher: 'W. W. Norton & Company' },
  { author: "O'Neil, Cathy", year: 2016, title: 'Weapons of Math Destruction: How Big Data Increases Inequality and Threatens Democracy', publisher: 'Crown' },
  { author: 'Noble, Safiya Umoja', year: 2018, title: 'Algorithms of Oppression: How Search Engines Reinforce Racism', publisher: 'NYU Press' },
  { author: 'Mollick, Ethan', year: 2024, title: 'Co-Intelligence: Living and Working with AI', publisher: 'Portfolio' },
  { author: 'UNESCO', year: 2021, title: 'AI and Education: Guidance for Policy-Makers', publisher: 'UNESCO' },
  { author: 'UNESCO', year: 2023, title: 'Guidance for Generative AI in Education and Research', publisher: 'UNESCO' },
  { author: 'U.S. Department of Education, Office of Educational Technology', year: 2023, title: 'Artificial Intelligence and the Future of Teaching and Learning: Insights and Recommendations', publisher: 'U.S. Department of Education' },
  { author: 'Congreso de la República de Colombia', year: 2012, title: 'Ley Estatutaria 1581 de 2012, por la cual se dictan disposiciones generales para la protección de datos personales', publisher: 'Diario Oficial' },
];

const fold = (s: unknown): string =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Primer apellido. "Apellido, Nombre …" → la primera palabra antes de la coma; "Nombre Apellido"
 * (sin coma) → la última palabra del primer autor; un autor institucional se compara igual en
 * ambos lados (catálogo y entrada pasan por la misma función).
 */
function firstSurname(author: unknown): string {
  const raw = String(author ?? '');
  const firstAuthor = fold(raw).split(/\sy\s|\sand\s|&|;/)[0].trim();
  if (firstAuthor.includes(',')) return firstAuthor.split(',')[0].trim().split(/\s+/)[0] || '';
  const words = firstAuthor.replace(/\(.*?\)/g, ' ').split(/\s+/).filter(Boolean);
  return words[words.length - 1] || '';
}

const STOP = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'on', 'de', 'del', 'la', 'el', 'los', 'las', 'y', 'en', 'para', 'por', 'ed', 'con']);
function titleTokens(t: unknown): Set<string> {
  return new Set(fold(t).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
}

/** Números del título (leyes, ediciones, tomos): deben coincidir exactamente. */
function titleNumbers(t: unknown): string {
  const nums: string[] = fold(t).match(/\d+/g) ?? [];
  return nums.filter((n) => n.length > 1).sort().join(',');
}

/**
 * Misma obra: ≥ 2 palabras en común y ≥ 75 % de cada título cubierto por el otro (en AMBOS
 * sentidos: un título largo distinto que contiene el corto no cuenta), y los mismos números.
 */
function sameTitle(a: unknown, b: unknown): boolean {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (!ta.size || !tb.size || titleNumbers(a) !== titleNumbers(b)) return false;
  let hit = 0;
  for (const w of ta) if (tb.has(w)) hit++;
  return hit >= 2 && hit / ta.size >= 0.75 && hit / tb.size >= 0.75;
}

export interface BibliographyVerification {
  kept: BibliographyEntry[];
  corrected: number;
  dropped: BibliographyEntry[];
}

/**
 * Publica solo obras verificadas, en su forma canónica. Coincidencia = mismo primer apellido,
 * mismo año y el mismo título (sameTitle). Ante la duda se omite: una omisión es segura, una
 * obra equivocada publicada como verificada no.
 */
export function verifyBibliography(list: readonly BibliographyEntry[] | null | undefined): BibliographyVerification {
  const kept: BibliographyEntry[] = [];
  const dropped: BibliographyEntry[] = [];
  let corrected = 0;
  const seen = new Set<string>();
  for (const b of list ?? []) {
    const s = firstSurname(b?.author);
    const match = VERIFIED_BIBLIOGRAPHY.find(
      (w) => firstSurname(w.author) === s && w.year === Number(b?.year) && sameTitle(w.title, b?.title),
    );
    if (!match) { dropped.push(b); continue; }
    const key = `${match.author}|${match.year}|${match.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (match.author !== b.author || match.title !== b.title || match.publisher !== b.publisher) corrected++;
    kept.push({ author: match.author, year: match.year, title: match.title, publisher: match.publisher });
  }
  return { kept, corrected, dropped };
}
