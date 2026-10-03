/* eslint-disable */
// r19 W — textos de bienvenida (`course_intro.welcome`) de largo real para los checks de composición.
//  - w625 / w616: las bienvenidas reales de los cursos #625 (Técnico, 141 palabras) y #616 (Editorial, 155), tal
//    cual salieron del paquete (r19/DIAG-W, diag-w/62x_s0_1000_label.html);
//  - short80 / long220: los extremos del esquema (80–220 palabras, intro-schemas.ts);
//  - abbrev: abreviaturas, decimales y «N.º» (no se corta dentro de ellos ni se pierde texto);
//  - longFirst: primera oración de > 40 palabras (no cabe en la entrada → va a tamaño de cuerpo, nunca como entrada).
'use strict';

const WELCOMES = {
  w625:
    'Imagina que llegas a trabajar a una panadería y lo primero que tienes que hacer es amasar. ¿Sabes si la mesada está limpia? ' +
    '¿La harina lleva el tiempo adecuado almacenada? ¿Tocaste algo crudo antes de manipular el pan terminado? Estas preguntas parecen ' +
    'simples, pero marcan la diferencia entre un producto seguro y uno que puede enfermar a quien lo consume. En Chile, el Reglamento ' +
    'Sanitario de los Alimentos establece las condiciones que deben cumplir quienes trabajan con alimentos, y las panaderías no son la ' +
    'excepción. Este curso te prepara para cumplir esas exigencias desde el primer día de trabajo: vas a aprender a identificar y prevenir ' +
    'la contaminación cruzada en tu puesto, y a conservar insumos y productos a las temperaturas correctas. Todo con ejemplos del día a día ' +
    'de una panadería, sin tecnicismos innecesarios, para que puedas aplicarlo de inmediato.',
  w616:
    '¿Alguna vez fuiste a un restaurante y la atención fue tan buena que volviste aunque la comida no era perfecta? Eso no pasa por ' +
    'casualidad. En la gastronomía peruana, los restaurantes familiares son el corazón de la industria: desde una cevichería en el Callao ' +
    'hasta una picantería en Arequipa, la experiencia del comensal depende en gran medida de quién lo atiende y cómo. Este curso te da las ' +
    'herramientas concretas para hacer ese trabajo bien desde el primer día. Vas a aprender a recibir a tus comensales con calidez, ' +
    'ubicarlos con criterio, tomar pedidos sin errores que lleguen a la cocina torcidos y, cuando algo salga mal, convertir ese momento ' +
    'incómodo en una razón para que el cliente quiera regresar. No necesitas experiencia previa. Solo necesitas ganas de entender que ' +
    'atender bien es una habilidad que se aprende, se practica y marca la diferencia entre un restaurante que crece y uno que lucha por sobrevivir.',
  short80:
    'Atender bien a una persona empieza mucho antes de decir la primera palabra. En este curso vas a practicar cómo escuchar con atención, ' +
    'cómo explicar una solución sin rodeos y cómo cerrar cada conversación con un acuerdo claro. Cada capítulo parte de una situación real ' +
    'del mostrador o del teléfono. Al final de cada tramo tendrás una práctica breve para comprobar lo aprendido y volver sobre lo que ' +
    'necesites, a tu ritmo y sin presión. Empieza cuando quieras y avanza paso a paso.',
  long220:
    'Cada día, miles de personas llegan a un mostrador, llaman a una línea de ayuda o escriben un mensaje esperando que alguien las ' +
    'escuche de verdad. Lo que pasa en esos momentos define si vuelven o si se van para siempre. Sin embargo, casi nadie nos enseñó a ' +
    'atender con método: aprendimos mirando a otros, repitiendo frases hechas y resolviendo como se pudo. Este curso cambia eso. Vas a ' +
    'conocer un recorrido completo, desde el primer saludo hasta el seguimiento posterior, con herramientas que puedes usar el mismo día. ' +
    'Empezaremos por la escucha activa, porque sin ella cualquier solución llega tarde o equivocada. Después trabajaremos la forma de ' +
    'explicar procesos complejos con palabras simples, sin perder la precisión que el cliente necesita para decidir. Más adelante ' +
    'abordaremos los reclamos difíciles, esos que ponen a prueba la paciencia, y verás cómo un método ordenado transforma una queja en ' +
    'confianza. También vas a practicar la negociación de acuerdos justos, para que ambas partes sientan que ganaron algo valioso. Cada ' +
    'capítulo combina una lectura breve, un ejemplo cercano y una práctica para que compruebes lo aprendido. No necesitas experiencia ' +
    'previa ni conocimientos técnicos. Solo necesitas curiosidad, disposición para probar cosas nuevas y ganas de mejorar la experiencia ' +
    'de cada persona que atiendes, empezando por la próxima que cruce tu puerta mañana.',
  abbrev:
    'El Dr. Ramírez lo resume así: la seguridad alimentaria se juega en los detalles. Una temperatura de 4.5 grados puede parecer ' +
    'suficiente, pero no siempre lo es. La Resolución N.º 3 lo deja claro para todo el sector. En EE. UU. y en Chile se usan criterios ' +
    'parecidos, aunque con matices. Este curso te muestra cómo aplicarlos en tu cocina, paso a paso, con ejemplos concretos y prácticas ' +
    'breves. Vas a revisar la recepción de insumos, el almacenamiento en frío, la manipulación en la línea y la limpieza al cierre del ' +
    'turno, siempre con la misma pregunta en mente: ¿esto protege a quien va a comer?',
  longFirst:
    'Cuando una persona entra a tu local con un problema que no sabe cómo explicar, con prisa, con dudas sobre lo que realmente necesita ' +
    'y con la sensación de que nadie la va a escuchar, lo que hagas en los primeros segundos define toda la conversación que viene después. ' +
    'Este curso te prepara para esos momentos. Vas a practicar la escucha activa, la explicación clara y el cierre con acuerdos que se ' +
    'cumplen, siempre a partir de situaciones reales del mostrador y del teléfono.',
};

/** Fixtures cuya primera oración NO cabe en la entrada (≤ 40 palabras / 240 caracteres). */
const NO_LEAD = new Set(['longFirst']);

module.exports = { WELCOMES, NO_LEAD };
