'use strict';
// Loop 10 C1: ejercicios guiados de prueba DISTINTOS entre sí (dentro del documento y entre capítulos).
//
// Cada situación = una apertura (A) + una complicación (B), de ~450 caracteres cada una. Dos ejercicios que comparten
// una mitad tienen Jaccard ≈ 1/3 (< 0,5); los de un mismo capítulo no comparten ninguna. Los tipos, las consignas y la
// respuesta modelo van por posición (E1 case_analysis, E2 decision_analysis, E3 worked_problem): nunca iguales en un
// mismo documento. Con `chapterOrdinal` distinto, el título y la combinación de mitades cambian (hasta 3 capítulos de
// 3 ejercicios sin repetir combinación). USD 0: texto fijo, sin IA.

const OPENINGS = [
  'Una tienda de electrodomésticos de barrio recibe a un cliente que compró una licuadora hace diez días y vuelve porque no enciende. Está molesto, trae la factura y pide que le devuelvan el dinero de inmediato. La política de la tienda permite cambio o reparación dentro del primer mes y la devolución solo con autorización de la administración, que hoy no está en el local. El cliente explica que usa el aparato en su negocio de jugos y que cada día sin él pierde ventas.',
  'Un restaurante de comida casera recibe por teléfono el reclamo de una clienta que pidió almuerzo a domicilio para su oficina: el pedido llegó una hora tarde, frío y con un plato equivocado. La clienta dice que tenía una reunión con proveedores y que quedó mal con ellos. El restaurante tiene una regla escrita de reposición del plato y un descuento en el siguiente pedido, pero nada sobre devoluciones. Es la tercera vez en el mes que esa oficina hace un pedido grande y el restaurante quiere conservarla.',
  'Una papelería cerca de un colegio vende a una madre de familia la lista completa de útiles escolares y, al revisar en casa, ella descubre que faltan dos cuadernos y que una caja de colores vino abierta. Vuelve al día siguiente con su hijo, la bolsa y el recibo, en plena temporada de regreso a clases, y pide que le completen todo sin hacer fila otra vez. La caja registradora muestra la venta completa, pero nadie recuerda quién armó esa bolsa el día anterior.',
];
const COMPLICATIONS = [
  'En la bodega queda una sola unidad igual, reservada para otro cliente que la recoge mañana, y el servicio técnico autorizado tarda entre cinco y ocho días hábiles en entregar una reparación. Detrás hay tres personas esperando en la fila y tu compañera de turno te pide que lo resuelvas rápido, sin prometer nada que el negocio no pueda cumplir ni saltarte el registro de la atención. Además, el gerente revisa cada semana las atenciones que quedaron sin cerrar.',
  'Esa mañana el sistema de caja está caído y solo se pueden registrar ventas y cambios a mano en el cuaderno de contingencia, que después alguien debe pasar al sistema. El encargado de inventario salió a una diligencia y no hay forma de confirmar existencias hasta la tarde. La persona afectada insiste en que necesita una respuesta ahora y amenaza con dejar una reseña negativa en internet. Tu turno termina en una hora y nadie más conoce el caso todavía.',
  'El dueño del negocio está de viaje y dejó dicho que ningún empleado autoriza compensaciones fuera de lo escrito, pero el mismo cliente ya se había quejado el mes pasado y ese caso se resolvió con un regalo que nadie registró. Tu compañero recuerda ese antecedente y te sugiere repetirlo para evitar problemas, aunque tú no sabes si fue una excepción autorizada o una decisión improvisada. Si repites el regalo, otros clientes podrían pedir lo mismo la próxima vez.',
];
// Combinaciones (apertura, complicación) en orden: las 3 primeras no comparten mitades; las siguientes comparten como mucho una.
const COMBOS = [[0, 0], [1, 1], [2, 2], [0, 1], [1, 2], [2, 0], [0, 2], [1, 0], [2, 1]];

const BODIES = [
  {
    kind: 'case_analysis',
    title: 'Un reclamo que no admite promesas vacías',
    tasks: [
      'Identifica qué necesita realmente la persona y qué permite la política del negocio en este caso.',
      'Propón una respuesta concreta con los pasos que seguirías, sin comprometer lo que no depende de ti.',
      'Justifica qué harías si la persona insiste en una solución que la política no autoriza.',
      'Explica cómo registrarías la atención para que quien decide pueda resolverla después.',
      'Decide cómo cerrarías la conversación para que la persona sepa qué pasa y cuándo, y justifica tu decisión.',
    ],
    expectedProduct: 'Una respuesta escrita a la persona con los pasos acordados, la fecha de respuesta y el registro de la atención.',
    criteria: [
      { name: 'Comprensión del caso', descriptor: 'Distingue lo que la persona pide de lo que realmente necesita.' },
      { name: 'Solución dentro de la política', descriptor: 'La respuesta respeta lo que el negocio permite.' },
      { name: 'Registro y seguimiento', descriptor: 'Deja trazabilidad para que el caso se cierre.' },
    ],
    modelAnswer: [
      '1. La persona necesita una solución que le devuelva lo que esperaba de la compra, no necesariamente lo que pide al llegar molesta. La política deja claro qué puede ofrecer el turno (cambio, reparación o reposición) y qué solo puede autorizar quien administra el negocio. Reconocer esa diferencia desde el inicio evita discusiones y promesas que después no se cumplen.',
      '2. Le ofreces de inmediato lo que la política sí permite, le explicas en qué consiste y cuánto tarda, y le dices con claridad qué parte depende de otra persona. Anotas su número de contacto y te comprometes a una fecha concreta de respuesta que el negocio pueda cumplir.',
      '3. Si insiste en lo que no está autorizado, le explicas con calma que esa decisión no la toma el turno y que no vas a prometerla, pero que dejas su solicitud por escrito para quien sí puede decidir. Así no la dejas sin respuesta ni comprometes al negocio con algo que quizá no se cumpla.',
      '4. Registras la fecha, el producto o servicio, el problema reportado, la solución ofrecida, la solicitud adicional de la persona y quién hace el seguimiento. Dejas el caso marcado como pendiente de decisión para que nadie lo tenga que reconstruir de memoria.',
      '5. Cierras repitiendo lo acordado: qué se hace hoy, qué queda pendiente, quién la va a llamar y cuándo. Le preguntas si quedó claro y le das un medio de contacto. Así la persona se va sabiendo qué esperar y el turno queda con la atención documentada y sin promesas que no dependan de él.',
    ].join('\n'),
  },
  {
    kind: 'decision_analysis',
    title: 'Elegir entre tres salidas posibles',
    tasks: [
      'Plantea al menos tres alternativas de solución que el turno podría ofrecer en esta situación.',
      'Compara las alternativas con tres criterios: lo que permite la regla escrita, el costo para el negocio y la confianza de la persona.',
      'Elige la alternativa que recomendarías y justifica por qué supera a las otras dos con esos criterios.',
      'Analiza qué riesgo tiene tu elección y cómo lo reducirías antes de comunicarla.',
      'Redacta en dos o tres frases cómo le explicarías la decisión a la persona afectada.',
    ],
    expectedProduct: 'Una tabla breve con tres alternativas comparadas por criterio, la elegida con su justificación y el mensaje para la persona.',
    criteria: [
      { name: 'Alternativas realistas', descriptor: 'Las opciones son posibles para el turno y distintas entre sí.' },
      { name: 'Comparación con criterios', descriptor: 'Cada alternativa se evalúa con los mismos criterios.' },
      { name: 'Decisión justificada', descriptor: 'La elección se sostiene en la comparación y reconoce su riesgo.' },
    ],
    modelAnswer: [
      '1. Las alternativas son: ofrecer ya lo que la regla escrita permite; dejar la solicitud registrada para que quien decide responda en una fecha concreta; o improvisar una compensación inmediata para calmar a la persona. Las tres son posibles, pero no tienen el mismo efecto.',
      '2. Frente a la regla escrita, la primera y la segunda la cumplen y la tercera no. En costo, la primera es la más predecible, la segunda depende de lo que se decida y la tercera puede repetirse con otros clientes. En confianza, la tercera calma en el momento, pero la segunda da una respuesta seria y verificable.',
      '3. Recomiendas combinar la primera con la segunda: entregas hoy lo que la regla permite y registras la solicitud adicional con fecha de respuesta. Supera a la compensación improvisada porque no crea un antecedente sin respaldo y supera a la primera sola porque no deja a la persona sin salida para lo que pide.',
      '4. El riesgo es que la persona sienta que la estás despachando; lo reduces explicando qué parte se resuelve hoy, quién decide el resto y cuándo la llaman, y anotando su contacto delante de ella. Si se compromete una fecha, verificas antes que quien decide pueda cumplirla.',
      '5. «Hoy le resolvemos lo que está en nuestras manos y le dejo por escrito su solicitud para la administración. Mañana antes del mediodía la llaman con la respuesta; este es el registro de su caso y este es el número para comunicarse si necesita algo antes.»',
    ].join('\n'),
  },
  {
    kind: 'worked_problem',
    title: 'Ordenar la atención paso a paso',
    tasks: [
      'Ordena en una secuencia los pasos de atención, desde que recibes a la persona hasta que cierras el caso.',
      'Calcula cuánto tiempo del turno necesitas para atenderla sin descuidar a quienes esperan, y explica tu estimación.',
      'Resuelve qué información mínima debes tomar en cada paso para que el caso no se pierda.',
      'Verifica tu secuencia contra la regla escrita del negocio y corrige el paso que no la cumpla.',
      'Propón cómo dejarías el caso para el siguiente turno si no alcanzas a cerrarlo hoy.',
    ],
    expectedProduct: 'Una secuencia numerada de pasos con el tiempo estimado, los datos que se toman en cada uno y la nota para el siguiente turno.',
    criteria: [
      { name: 'Secuencia completa', descriptor: 'Los pasos van de la recepción al cierre sin saltos.' },
      { name: 'Estimación razonada', descriptor: 'El tiempo propuesto se explica con lo que exige cada paso.' },
      { name: 'Continuidad del caso', descriptor: 'Otro turno puede retomar el caso con lo registrado.' },
    ],
    modelAnswer: [
      '1. La secuencia es: saludar y escuchar el problema completo; revisar el comprobante y el producto o servicio; explicar lo que la regla permite; ofrecer la solución disponible; registrar la atención y la solicitud adicional; acordar el seguimiento; y despedirse confirmando lo acordado.',
      '2. Estimas unos diez minutos: tres para escuchar y revisar, tres para explicar y ofrecer, tres para registrar y uno para cerrar. Mientras tanto avisas a quienes esperan que en pocos minutos los atiendes, o pides a un compañero que tome la fila si la atención se alarga.',
      '3. En la recepción tomas el nombre y un teléfono; en la revisión, la fecha del comprobante y el problema; en la oferta, la solución aceptada o rechazada; en el registro, la solicitud adicional y quién decide; y en el cierre, la fecha de seguimiento acordada con la persona.',
      '4. Al comparar con la regla escrita notas que en el paso de la oferta habías incluido una compensación que solo autoriza la administración; lo corriges: ofreces lo permitido y la compensación pasa al registro como solicitud pendiente de decisión, sin prometerla.',
      '5. Si no alcanzas a cerrarlo, dejas en el cuaderno del turno una nota con los datos tomados, lo que se ofreció, lo que quedó pendiente, quién decide y la fecha prometida a la persona, y avisas en persona al siguiente turno para que la llamada de seguimiento no se pierda. Así la persona recibe la respuesta prometida aunque cambie quien la atiende.',
    ].join('\n'),
  },
];

const PLAN = { 40: [20, 20], 60: [30, 30], 80: [40, 40], 120: [40, 40, 40] };

/** Ejercicio i (0..2) del capítulo `chapterOrdinal` (0..2): contenido del LLM (sin id ni minutos). */
function guidedExercise(i, chapterOrdinal = 0, label = '') {
  const [a, b] = COMBOS[(chapterOrdinal * 3 + i) % COMBOS.length];
  const body = BODIES[i % BODIES.length];
  const suffix = label ? ` (${label})` : chapterOrdinal ? ` (parte ${chapterOrdinal + 1})` : '';
  return {
    kind: body.kind,
    title: (body.title + suffix).slice(0, 90),
    situation: `${OPENINGS[a]} ${COMPLICATIONS[b]}`,
    tasks: body.tasks.slice(),
    expectedProduct: body.expectedProduct,
    criteria: body.criteria.map((c) => ({ ...c })),
    modelAnswer: body.modelAnswer,
  };
}
/** Respuesta del LLM con n ejercicios distintos. */
function guidedLlmDoc(n, chapterOrdinal = 0, label = '') {
  return { exercises: Array.from({ length: n }, (_, i) => guidedExercise(i, chapterOrdinal, label)) };
}
/** Documento `dynamic_guided_practice_json` completo (ids y minutos del plan de Cursia). */
function guidedPracticeDocDistinct(chapterId, minutes, chapterOrdinal = 0, label = '') {
  return {
    schemaVersion: 1, chapterId, minutes,
    exercises: PLAN[minutes].map((m, i) => ({ id: `E${i + 1}`, minutes: m, ...guidedExercise(i, chapterOrdinal, label) })),
  };
}

module.exports = { OPENINGS, COMPLICATIONS, COMBOS, BODIES, guidedExercise, guidedLlmDoc, guidedPracticeDocDistinct };
