# CURSIA V2 DESIGN LANGUAGE V1

Status: R14-A. This is the binding spec for `visual-components/render.ts`, `runtime.ts`,
`course-shell/*` and `theme-engine/families.ts`. Source audit: *Cursia V2.1 Visual Audit*
(2026-09-27).

## 0. Thesis

**A course page is an editorial page, not a stack of cards.**

- Knowledge sits **open** on the page by default.
- Structure comes from typography, rules, numerals, whitespace and (in ENHANCED) columns.
- A *surface* (fill, border, radius) is a statement that says "this is a different kind
  of thing". It is spent on 4 roles only (§3), never nested, at most 2 per label.
- One chapter has exactly **one peak**: the chapter opener. Everything else steps down
  from it.

Non-goals: more boxes, more shadows, more gradients, more icons. Emoji never. Side-stripe
borders (colored `border-left` as an accent on a block) never. The timeline axis is the
only vertical rule, and it is structural.

## 1. Typography

System stacks only, no webfonts. The reasons: Moodle privacy/CSP, offline Moodle, and the
fact that `forceclean` drops everything anyway. Personality comes from *which* system
family and how it is set.

| Role | CLEAN_SAFE | ENHANCED (fluid) | Line-height | Weight | Notes |
|---|---|---|---|---|---|
| display (course/chapter/module title) | 40px | clamp(2rem, 1.3rem + 2.8vw, 3.25rem) | 1.08 | family display weight | letter-spacing −0.015em, `fontDisplay` |
| numeral (chapter, step, objective) | 36px | clamp(2.25rem, 1.6rem + 2.4vw, 3.5rem) | 1 | 700 | `fontNumeral`, accentStrong |
| statement (thesis, central idea, reflection) | 26px | clamp(1.375rem, 1.1rem + 1.2vw, 1.875rem) | 1.3 | 600 | `fontDisplay`, italic in Editorial |
| title (component h4) | 26px | clamp(1.375rem, 1.1rem + 1.1vw, 1.875rem) | 1.2 | heading weight | `fontHeading` |
| item (h5) | 20px | clamp(1.125rem, 1.05rem + .4vw, 1.3125rem) | 1.3 | 600 | Moodle's HTMLPurifier (forceclean) drops non-100 weights such as 650: use only multiples of 100 |
| lead | 21px | clamp(1.1875rem, 1.05rem + .6vw, 1.375rem) | 1.5 | 400 | measure 60ch |
| body | 18px | clamp(1.0625rem, 1rem + .35vw, 1.1875rem) | 1.65 | 400 | measure = family (62–74ch) |
| small | 16px | — | 1.5 | 400 | floor for any non-meta text |
| meta / kicker (`cvc-meta`) | 14px | — | 1.4 | 700 | uppercase, tracking .08em, `fontMeta` (mono in Técnico) |

Scale steps are ≥ 1.25 between roles that must read as different levels (body→title 1.44,
title→display 1.54). Item headings separate from body by weight, not size.

Mobile (≤ 480px): display floors at 32px, titles at 22px, body at 17px (the fluid clamps
already do this). Measure stops mattering because the column is narrower than the measure.

**Kicker (eyebrow/meta).** Every component opens with a kicker that states *what kind of
thing this is*: "Glosario", "Profundiza", "Caso". It replaces the old pills. A count appears
only where it helps navigation ("Proceso · 6 pasos", "Línea de tiempo · 3 hitos",
"Autoevaluación · 4 preguntas"). Counts on every block read as a template; that was a
review finding. Counts come from the data (array length), never from invented facts.

## 2. Spacing

The base unit is 8. `density` per family multiplies the vertical rhythm: compact .85,
regular 1, airy 1.15.

| Token | px (regular) | Use |
|---|---|---|
| component gap | 64 (major: hero, process, comparison, synthesis, case, timeline, accordion, glossary, tabs) / 44 (minor) | rhythm: major blocks get a longer pause after them |
| title gap | 20 | component title → content |
| item gap | 20 | between rule-separated items |
| panel padding | 28 × 32 | case, summary, reveal panels |
| root padding (light) | 8 × 4 | label root: content is open on the Moodle page |
| root padding (dark plate) | 24 (SAFE) / clamp(20px, 3.2vw, 44px) | dark families paint one plate per label |

Density means *air between groups*, not padding inside boxes.

## 3. Surfaces: when to use what

| Surface | Look | Use for | Never for |
|---|---|---|---|
| **open** (default) | text on the label ground | objectives, glossary, process, timeline, accordion, tabs, self-check, checklist, comparison, myth/reality | — |
| **tinted section** | `surfaceAlt` fill, radius md, no border | summary / key takeaways (chapter synthesis) | more than one per label |
| **panel** | `surface` or `surfaceAlt` + 1px `border`, radius md | case scenario, reveal cards | nesting another surface |
| **outlined block** | label ground + full 1px (warning: 2px) border in the variant color | callout tip/info/warning/example, next-step transition | long content |
| **editorial split** | two columns in ENHANCED ≥ 720px, stacked in SAFE | chapter opener, myth/reality rows, objectives (≥ 4), glossary | text-heavy paragraphs |
| **full-width emphasis** | accent band/plate per family hero treatment | chapter opener meta band (Institucional), soft plate (Vibrante) | body text on saturated fill |
| **plate** (dark only) | the label root itself | dark families: one plate per label, everything inside is open | a second plate inside |

Rule: **no surface inside a surface.** A panel's items are separated by rules, not by
nested cards.

## 4. Geometry

- **Radius**: from the family (`sm/md/lg`). Radius only on surfaces, never on open content.
  Pills (999px) only on real interactive affordances (tabs, reveal buttons).
- **Borders**: 1px `border` for panels, 1px `border` rules between items, 2px only for
  warning callouts and the Institucional section rule.
- **Accent rule**: a 40–56px × 3px bar in `accent` (a `div` with `width` + `border-top`,
  CLEAN_SAFE). It marks the chapter opener and the central idea, and nothing else.
- **Dividers**: `border-top: 1px solid border` between list items and between the
  components of the same movement when the family asks for it (`ruleBetween`).
- **Shadows**: none. Premium comes from type and space, not elevation.

## 5. Component personality

| Component | Identity (silhouette) |
|---|---|
| hero / **chapter opener** | The chapter's peak. Order: meta line "Módulo 1 · Capítulo 1 · {eyebrow}", then the chapter **title** in display, then the accent rule, then the **thesis** (hero.title) in statement type, then the lead. ENHANCED ≥ 720: a split with a large chapter numeral in the left column. The treatment changes per family (rule / band / plate). There is no saturated slab behind body text. |
| **module opener** | A large module numeral, the module title in display and the presentation as lead. Outcomes follow as a numbered list, then the chapter map as rule-separated rows (numeral, title, one line). |
| course hero (welcome) | Meta "Bienvenida", the course title in display, then the lead. Facts sit in a single row of numbers with hairline dividers (ENHANCED) or one meta line (SAFE). No stat cards. |
| learning objectives | "Al terminar podrás". A numbered list with mono/tabular numerals "01…", rule-separated, in 2 columns when there are 4 or more items (ENHANCED). |
| concept cards → **glossary** | A 2-column grid (ENHANCED). Each entry has a rule on top, the term in heading type and the definition. No boxes. |
| reveal cards | Panels (one per card). The front is the prompt in bold; the reverse sits behind a "Ver respuesta" pill button. There is no "Frente" badge. |
| accordion | Rule-separated rows, the heading in item type and a circular + / − control on the right. The first row stays open. |
| tabs | An underline tab bar (ENHANCED) with an open panel. SAFE: stacked sections with a rule. |
| timeline | A vertical axis (2px `borderStrong`), a dot marker per event, the marker text in meta type and accent color, then heading and body. |
| process | Big numerals in the accent color in a left column (ENHANCED grid 72px / 1fr), a heading with the redundant "Paso N:" stripped, then the body, with rules between steps. |
| comparison | A real table: no fills except the header row (`surfaceAlt`) and the first column in bold. Horizontal rules only. More than 2 columns: stacked in SAFE, full table in ENHANCED ≥ 720px. |
| myth / reality | Rows split in two columns: "Mito" (danger text, secondary color, normal weight) next to "Realidad" (success text, primary, bold). The reality is revealed with "Ver la realidad". |
| case scenario | A panel (`surfaceAlt`) with kicker "Caso", the title in heading type and the narrative. "Preguntas guía" is a kicker followed by the questions with accent numerals. |
| checklist | An open list with a ☐ glyph and a hanging indent. |
| reflection | An editorial "pull quote": a large accent quotation mark and the prompt in statement type (italic in Editorial) between two rules. The hint sits behind a "Ver una pista" button. |
| callout | An outlined block, with the label as colored text (Consejo / Atención / Dato / Ejemplo) followed by title and body. Warning uses a 2px border. |
| summary visual → **key takeaways** | The chapter's **climax**: a tinted section with kicker "Ideas clave", the accent rule, the central idea in display-scale statement type (≈32–40px, italic in Editorial), then the points as a numbered list (2 columns when the points are short). |
| self-check | Rows with kicker "Pregunta N", the question in item type and a "Ver respuesta" pill button. |
| next-step transition | A 2px accent rule on top, the kicker "A continuación" and one to two lines. It is not a box. |
| activity / video intro | Kicker "Práctica calificada" / "Video interactivo", a title, the instruction, and a facts line (grade, attempts) in meta type. |
| Gamma presentation | A figure: the cover full width (radius md), a caption line and a button-styled link "Ver presentación (PDF, N diapositivas)". |

*Quote*, *formula/data* and a standalone *key takeaway* are not in `VC_SCHEMA_VERSION 1`.
Adding them is a schema change: generator prompt, validator and a version bump. That is
listed as follow-up work, not faked with existing types.

## 6. Themes = families, not palettes

`ThemePersonality` (new, part of `ResolvedTheme`, THEME_ENGINE_VERSION 2):

| token | values |
|---|---|
| fontDisplay / fontMeta / fontNumeral | system stacks |
| displayWeight | 600–800 |
| thesisItalic | bool |
| heroTreatment | `rule` · `band` · `plate` |
| density | `compact` · `regular` · `airy` |
| ruleBetween | bool (rules between components) |
| metaTracking | em |
| sectionRule | bool: a 2px full-width accent rule over each component kicker (Institucional letterhead) |
| gridRules | bool: item rules in `borderStrong` (a datasheet grid, Técnico) |
| plate | bool: the label root paints its own plate (dark families) |

| Family | Type | Treatment | Feel |
|---|---|---|---|
| Aula clara | humanist sans throughout, display 700 | rule hero, airy, radius 12 | warm, friendly classroom |
| Institucional | grotesk, display 700, meta tracked, **section rule** over every component | band hero (thin accent band carrying the meta line), 2px section rules, regular, radius 4 | formal, letterhead |
| Editorial | serif text and display, italic thesis, sans meta | rule hero, airy, radius 2, hairlines, rules between components | magazine / book |
| Técnico | grotesk and **mono** meta/numerals | rule hero with mono index, compact, radius 2 | datasheet, engineering |
| Vibrante | rounded sans, display 800 | plate hero (soft accent plate), regular, radius 20 | energetic, youthful |
| Oscuro premium | grotesk body, **serif display** | dark plate root, rule hero, airy, radius 14 | cinematic, premium |

## 7. Accessibility and Moodle (unchanged guarantees)

- CLEAN_SAFE: every text has an explicit color over a solid ancestor background at 4.5:1 or
  more, no text below 16px except `cvc-meta` (14px or more), no content hidden in the base,
  and the label linted by `lintCleanSafe` before packaging.
- ENHANCED adds layout (grid/flex), fluid sizes, radius, details/tabs behaviour and hover or
  focus states. With `forceclean=1` the page must remain complete, ordered and readable in
  one column.
- Focus is always visible (3px outline). `prefers-reduced-motion` is honored. The tab
  order follows the reading order.

## 8. Implementation notes (R14-A)

- Layout in columns lives only in the scoped `<style>` and uses **container queries** on the
  label (`container-type:inline-size`), not viewport media queries: Moodle's content column
  is narrower than the viewport.
- Reveal controls: the ENHANCED `<summary>` button and the CLEAN_SAFE lead use the **same
  word** (Respuesta / Realidad / Pista), because both levels must carry identical text.
- Shell labels (welcome, competencies) render components with `countless: true`: shell
  numbers must come from facts, so no counts in kickers and no index numerals there.
- The timeline axis is a CSS pseudo-element (ENHANCED). In CLEAN_SAFE the timeline is an
  open list with meta markers, so there is no side-stripe border in any HTML.
- Chapter opener: `renderMovement(..., { opener })` promotes the first `hero` of the opening
  movement to the chapter peak: meta line, display title (h2), accent rule, thesis, lead,
  and a large numeral in ENHANCED ≥ 600px of container.
