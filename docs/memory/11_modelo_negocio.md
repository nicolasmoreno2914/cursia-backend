# 11 — Modelo de negocio

---

## Propuesta de valor

> **"Cursos Moodle completos en días, no meses."**

Cursia elimina el cuello de botella de la producción de contenido educativo para Moodle. Lo que antes requería meses de trabajo de diseñadores instruccionales, locutores y desarrolladores SCORM, Cursia lo entrega en horas con IA.

---

## Oferta actual (fase Go-to-Market)

### Servicio consultivo + herramienta

No se vende solo la herramienta. Se vende el resultado:

**Diagnóstico de transformación virtual educativa (gratuito)**
- Reunión para entender el contexto del cliente
- Análisis de su contenido existente
- Propuesta de qué cursos crear y en qué orden
- Sin compromiso

**Sprint Cursia (pago)**
- 1 a 3 cursos Moodle completos listos para importar
- Estructura + libro guía + SCORM + quizzes + audio
- Entrega en 5 a 10 días hábiles
- Revisión incluida

---

## Embudo de conversión

```
Consultoría gratuita (diagnóstico)
    ↓
Propuesta de Sprint
    ↓
Piloto pago (1-3 cursos)
    ↓
Caso de éxito documentado
    ↓
Plan SaaS mensual / licencia institucional
```

---

## Planes SaaS (diseñados, no implementados)

| Plan | Cursos/mes | Funciones | Precio estimado |
|---|---|---|---|
| Basic | 2 | Generación + MBZ | $49/mes |
| Pro | 10 | + Audio + Drive + Cloud Save | $149/mes |
| Enterprise | Ilimitado | + Video + YouTube + API | Personalizado |

**Implementación futura requiere**:
- Tabla `subscriptions` en backend
- Integración con Stripe o LemonSqueezy
- Validación de límites en backend (no en frontend)
- Webhooks de billing

---

## Estrategia de posicionamiento (estilo Hormozi)

**No vender IA. Vender el resultado.**

- ❌ "Usa IA para crear cursos más rápido"
- ✅ "Tu curso Moodle listo en 5 días — con material completo"

**Reducir el riesgo al mínimo**:
- Diagnóstico gratuito (sin fricción)
- Sprint pago (resultado tangible antes de comprometerse)
- Caso de éxito como prueba social

**Stack de valor** (por qué es difícil replicar gratis):
- Prompts altamente optimizados (IP de Cursia)
- Integración nativa con Moodle (MBZ válido)
- SCORM pedagógicamente sólido
- Audio con voz natural
- Acompañamiento en el primer sprint

---

## Mercado objetivo

1. **Docentes universitarios** que deben migrar presencial a virtual
2. **Empresas de capacitación** con necesidad de onboarding escalable
3. **Instituciones educativas** con presupuesto limitado para producción
4. **Consultores de eLearning** que quieren escalar su producción

---

## Métricas clave para validar el modelo

- Costo por curso generado (IA + tiempo humano)
- Tiempo desde brief hasta MBZ exportable
- Satisfacción del cliente con el resultado en Moodle
- Retención (¿vuelve a pedir más cursos?)
- Ahorro estimado vs. producción tradicional

Estas métricas se alimentan del **Dashboard Admin** (ver archivo 10).

---

## Lo que NO es Cursia (anti-posicionamiento)

- No es una plataforma LMS (no reemplaza Moodle)
- No es un chatbot de preguntas y respuestas
- No es una herramienta de diseño instruccional genérica
- No compite con Canva, Rise 360 o Storyline directamente
- No requiere que el cliente entienda IA para usarla
