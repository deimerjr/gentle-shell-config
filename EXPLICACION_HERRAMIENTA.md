# Guía Explicativa: Ecosistema Gentle Shell & Pi Overlay
> **Documento base para Claude:** Este documento está diseñado para ser la fuente de verdad estructurada que Claude utilizará para crear un guion de video explicativo, dinámico y pedagógico, dirigido a **personas no programadoras**.

---

## 1. Instrucciones de Tono y Formato para Claude

Cuando generes el guion del video a partir de este documento, ten en cuenta las siguientes pautas:
- **Audiencia:** Emprendedores, directores de proyecto, creadores de contenido, entusiastas de la tecnología y público general interesado en la Inteligencia Artificial que **no sabe programar ni tirar líneas de comando**.
- **Tono:** Cercano, entretenido, pedagógico y profesional. Evita tecnicismos oscuros; si mencionas un término técnico, acompáñalo inmediatamente con una analogía visual o cotidiana.
- **Metáfora Central Obligatoria:** **"La Obra en Construcción Inteligente"**.
  - La IA genérica es como contratar a un albañil con mucha energía pero muy distraído, que si trabaja solo puede derribar una pared que no debía o pintar sobre una ventana.
  - **Gentle Shell** es el equipo completo de arquitectura: un **Director de Obra** que planifica, una **Cuadrilla de Especialistas** con roles estrictos (el agrimensor, el constructor, el inspector municipal), un **Comité de Calidad** y una **Torre de Control / Ángel Guardián** que vigila que nadie se quede sin material, que no se sobrecargue la memoria y que todo quede anotado en la bitácora.

---

## 2. ¿Qué es esta Herramienta? (La Visión General)

### El Problema de la IA Tradicional
Hoy en día, herramientas como ChatGPT o Claude son capaces de generar código de manera asombrosa. Sin embargo, cuando se les pide construir un sistema grande o mantener un proyecto real, sufren de tres grandes defectos:
1. **Amnesia por sobrecarga (Límite de Contexto):** Si la conversación se hace muy larga, la IA empieza a olvidar lo que habló al principio, confunde variables o empieza a "alucinar" (inventar cosas que no existen).
2. **Entusiasmo destructivo:** Le pides que agregue un botón nuevo y, sin darse cuenta, modifica o borra la lógica del sistema de pagos que ya funcionaba bien.
3. **Falta de verificación independiente:** El mismo que escribe el código dice que "todo funciona perfecto", sin que nadie imparcial corrobore si realmente cumple las reglas o si rompe algo por detrás.

### La Solución: Gentle Shell & Pi Overlay
**Gentle Shell** no es un modelo de inteligencia artificial nuevo; es un **harness y sistema de supervisión de calidad superior** que se coloca por encima del asistente de desarrollo (**Pi**). 

Transforma el trabajo caótico de una IA en un **proceso industrial controlado, seguro y con supervisión profesional**. En lugar de tener a una sola IA intentando hacer todo a la vez, Gentle Shell organiza un **ecosistema coordinado** donde cada tarea pasa por etapas de validación, especialistas dedicados y guardianes automáticos.

---

## 3. Desglose Detallado Módulo por Módulo

A continuación se explica cada uno de los componentes de la herramienta, qué hace en el fondo y cómo representarlo de forma sencilla en el video.

---

### Módulo 1: El Director de Obra y el Método ODD
*(el Gentleman & Organic Driven Development)*

- **¿Qué es?:** Es el cerebro coordinador principal. En este entorno se le conoce como **el Gentleman**. No es un bot conversacional que se apura a escribir código; actúa como un arquitecto senior.
- **Metodología ODD (Desarrollo Guiado Orgánico):** 
  En vez de lanzarse a teclear código a ciegas, sigue un método estricto en 7 pasos:
  1. **Autorizar:** Si el usuario solo pidió una explicación o una consulta, no se toca ningún archivo.
  2. **Explorar:** Inspecciona el terreno existente antes de proponer cambios.
  3. **Aclarar Incertidumbres:** Si una decisión del negocio no está clara, se frena y hace **una sola pregunta precisa** al usuario antes de asumir cosas.
  4. **Clasificar el tamaño:** Determina si el trabajo es chico (se resuelve en el momento) o grande (requiere planos y cuadrilla).
  5. **Crear la Hoja de Ruta antes de construir:** Para tareas grandes, escribe una lista de especificaciones estrictas con las palabras exactas del usuario.
  6. **Construir paso a paso con "Prueba Primero" (Test-First):** Antes de armar la cerradura, se construye la prueba para ver que la puerta realmente quede trabada. Si la prueba falla al principio (rojo) y luego de escribir la función pasa con éxito (verde), se demuestra que la solución funciona.
  7. **Cierre y Entrega:** Solo se da por terminado el trabajo cuando todas las pruebas pasaron de verdad y se evaluó el riesgo residual.
- **Analogía para el video:** Es como un jefe de obra que nunca deja pegar un solo ladrillo hasta que los planos están firmados, el terreno está medido y los inspectores tienen claro qué van a revisar.

---

### Módulo 2: La Cuadrilla de Especialistas (Subagentes)
*(Los trabajadores con tareas específicas y delimitadas)*

En lugar de que un solo agente intente investigar, programar y auditar todo junto, Gentle Shell delega las tareas en **subagentes especializados**, cada uno con herramientas estrictamente limitadas para evitar accidentes:

#### A. El Explorador (`gentle-ai-explore`)
- **Su trabajo:** Es el agrimensor / detective. Inspecciona los archivos del proyecto, busca dónde están las funciones y reúne evidencia con números de línea exactos.
- **Regla de oro:** **Tiene prohibido editar código.** Solo puede leer y buscar. Así nunca puede romper nada mientras investiga.
- **En el video:** Imagínalo con una lupa y una libreta de notas, mapeando la casa sin mover un solo mueble.

#### B. El Constructor (`gentle-ai-worker`)
- **Su trabajo:** Es el carpintero o instalador. Recibe una orden muy clara: *"Modifica únicamente estos archivos específicos y resuelve esta tarea puntual"*.
- **Seguridad (Superficie de edición permitida):** No tiene acceso libre a todo el proyecto. Si intenta modificar un archivo fuera de su área asignada, el sistema lo bloquea automáticamente.
- **En el video:** Un operario que trabaja dentro de una zona delimitada con cinta de peligro; solo arregla la canilla del baño sin tocar la electricidad de la cocina.

#### C. El Inspector de Calidad (`gentle-ai-verify`)
- **Su trabajo:** Es el auditor independiente. Lee el pedido original del usuario, ejecuta pruebas automatizadas en un entorno seguro y verifica que lo que hizo el Constructor cumpla la promesa al 100%.
- **Importancia:** Como es un agente distinto del que programó, no tiene los "sesgos" ni el exceso de confianza de quien escribió el código.
- **En el video:** El inspector con casco blanco y portapapeles que prueba abrir y cerrar la puerta 10 veces para certificar que no se traba.

#### D. Los Cuatro Ojos de la Revisión: Auditores 4R
Cuando un cambio es sensible o de alto riesgo, se activan cuatro lentes de revisión independientes:
1. **Riesgo (Risk):** ¿Esto pone en peligro contraseñas, dinero, permisos o datos guardados?
2. **Confiabilidad (Reliability):** ¿La lógica responde siempre igual o puede fallar con datos inesperados?
3. **Resiliencia (Resilience):** ¿Qué pasa si se corta internet, se cae un servidor o se agota el tiempo de espera? ¿Se recupera con elegancia o explota la aplicación?
4. **Legibilidad (Readability):** ¿El código y los mensajes que ve el usuario son claros, ordenados y fáciles de entender?
- **En el video:** Cuatro peritos con anteojos de distintos colores examinando la misma pieza desde cuatro ángulos diferentes.

#### E. El Tribunal de Juicio Adversarial (*Judgment Day*)
- **¿Qué es?:** Para cambios críticos, el sistema puede convocar a un "juicio".
- **Los Jueces Ciegos (`jd-judge-a` y `jd-judge-b`):** Dos agentes que evalúan el código por separado, sin hablar entre sí y sin poder modificar nada.
- **El Agente Reparador (`jd-fix-agent`):** Si ambos jueces detectan fallas, entra en acción este especialista para corregir exactamente lo señalado, tras lo cual se realiza una segunda votación.
- **En el video:** Un tribunal de justicia donde dos jueces dictan veredicto imparcial sobre si el trabajo es digno de ser entregado.

---

### Módulo 3: El Supervisor y Controlador de Vuelo (`orchestrator-supervisor`)
*(El Ángel Guardián del sistema)*

Este es uno de los módulos más avanzados y sofisticados de todo el repositorio. Funciona en segundo plano como una torre de control que protege a la IA de sus propias debilidades físicas y computacionales.

Sus funciones vitales son:

#### 1. El Guardián de Memoria y Contexto (`context-guard`)
- **El problema:** La memoria a corto plazo de una IA (su "ventana de contexto") se llena a medida que trabaja. Cuando supera el 80% o 90%, su capacidad de razonamiento decae en picada y empieza a cometer errores graves.
- **Lo que hace el Supervisor:** Monitorea en tiempo real el porcentaje de atención consumido. Si llega a la zona crítica, frena preventivamente, guarda un resumen perfecto de todo lo hecho y aprendido, y abre una **sesión nueva y fresca** sin perder el hilo.
- **Analogía para el video:** Es como un piloto que monitorea el tanque de combustible; antes de quedarse sin nafta en pleno vuelo, aterriza suavemente en una pista de relevo y continúa con un avión nuevo y el plan de vuelo intacto.

#### 2. La Memoria a Largo Plazo (Integración con Engram)
- **El problema:** Al cerrar una sesión o rotar a una nueva, las IAs convencionales sufren amnesia total.
- **Lo que hace el Supervisor:** Se conecta con **Engram**, un sistema de base de datos de memoria persistente. Almacena decisiones clave, arquitecturas acordadas y bitácoras de tareas, permitiendo que la IA recuerde el contexto histórico aunque pasen días o semanas.
- **Analogía para el video:** La libreta de bitácora del capitán de barco, donde cada guardia anota los eventos para que la siguiente guardia sepa exactamente dónde está la nave.

#### 3. El Administrador Inteligente de Modelos y Cuotas (`quota-manager`)
- **El problema:** Las APIs de Inteligencia Artificial (OpenAI, Claude, Gemini, etc.) tienen límites de uso por minuto, costos variables o pueden sufrir caídas repentinas.
- **Lo que hace el Supervisor:** Sabe cuánto crédito o cuota queda en cada cuenta. Si un proveedor falla o se satura (error de límite de velocidad), cambia de inmediato a un modelo alternativo configurado sin que el usuario tenga que reiniciar todo.
- **Analogía para el video:** Un generador eléctrico de emergencia en un hospital: si la red principal se corta, el generador arranca en una fracción de segundo y las luces nunca se apagan.

#### 4. Candados Atómicos y Protección contra Choques (`lock.ts` y `atomic-json.ts`)
- **El problema:** Si dos tareas o dos subagentes intentan escribir sobre el mismo archivo al mismo tiempo, el archivo se rompe o se corrompe.
- **Lo que hace el Supervisor:** Utiliza un sistema de **cerrojos seguros** (*locking*). Cada vez que alguien necesita escribir información sensible, "pide la llave", bloquea el archivo para los demás, guarda los cambios de forma instantánea y luego libera la llave. Además, si un proceso se traba o muere repentinamente, el sistema detecta que el dueño del candado ya no existe y recupera el acceso de forma segura.
- **Analogía para el video:** El semáforo de una esquina muy transitada que nunca se pone en verde para dos calles a la vez.

#### 5. Compatibilidad Multiplataforma (Linux & Windows)
- El supervisor está diseñado para operar con máxima precisión tanto en servidores **Linux** (aprovechando características nativas del sistema operativo) como en máquinas de escritorio con **Windows** (manejando con cuidado el sistema de archivos NTFS y los comandos `.cmd`).

---

### Módulo 4: El Adaptador Universal de Conexión (`cliproxyapi-dynamic-provider.ts`)
*(El Enchufe Internacional)*

- **¿Qué es?:** Es un módulo de comunicación dinámica.
- **Su función:** Permite que Pi y Gentle Shell se conecten de manera transparente con un servidor local llamado **CLIProxyAPI**. Este servidor administra y enruta diferentes cuentas y modelos (como Claude 3.5 Sonnet, Gemini 1.5/2.0 Flash, GPT-4o, etc.).
- **El beneficio para el usuario:** No hace falta cambiar la configuración a mano cada vez que se quiere usar una cuenta diferente o probar un modelo nuevo; el adaptador detecta qué modelos están activos y los pone a disposición del sistema al instante.
- **Analogía para el video:** Un adaptador universal de viaje que te permite enchufar tu computadora en cualquier país del mundo sin preocuparte por el voltaje ni la forma del tomacorriente.

---

### Módulo 5: El Tablero de Control y Ajustes (`settings.json`, `subagents.json`, `/supervisor`)
*(El Panel de Mandos)*

- **¿Qué es?:** Es donde el usuario define las reglas del juego.
- **Qué contiene:**
  - Qué modelo de IA se usa por defecto (por ejemplo, modelos rápidos y económicos para tareas cotidianas y modelos profundos de razonamiento para la auditoría).
  - Qué herramientas y extensiones están autorizadas.
  - El comando interactivo `/supervisor`, que despliega en la pantalla un tablero visual en tiempo real con el estado de las tareas, la salud del contexto y las cuotas disponibles.
- **Analogía para el video:** El panel de instrumentos en la cabina de un avión moderno, con todos los relojes, medidores de combustible y luces de estado en un solo lugar.

---

## 4. Resumen de Capacidades Reales vs. Lo que No Hace (Para no prometer de más en el video)

Es fundamental que el guion de video sea honesto y preciso sobre lo que el sistema hace hoy:

| Lo que SÍ hace de forma comprobada | Lo que NO hace (No prometer en el video) |
| :--- | :--- |
| Coordina equipos de subagentes especializados con roles estrictos. | No es un software "mágico" sin intervención humana; el usuario sigue siendo quien da las directivas finales. |
| Impide que los agentes modifiquen archivos fuera de su zona autorizada. | No elimina por completo los errores de lógica, pero los detecta antes de que lleguen a producción gracias a las pruebas. |
| Monitorea la memoria y rota las sesiones automáticamente antes de que la IA delire. | No guarda conversaciones infinitas de terabytes en RAM; sintetiza y preserva lo esencial en Engram. |
| Resiste caídas de conexión y conmuta entre modelos y cuentas disponibles. | No regala tokens ni salta los cobros de las APIs oficiales; optimiza y administra lo que el usuario tiene contratado. |
| Funciona tanto en Linux como en Windows de forma probada (261 tests unitarios automáticos). | No requiere saber programar para entender su concepto, aunque su instalación técnica actual está pensada para terminales de desarrollador. |

---

## 5. Propuesta de Estructura de Guion para el Video (Recomendación para Claude)

Claude puede estructurar el video en **5 bloques dinámicos** de entre 1 y 2 minutos cada uno (total estimado: 6 a 8 minutos de video):

### Bloque 1: El Gancho (0:00 - 1:15)
- **Tema:** "¿Por qué la IA común arruina tu código cuando le pides cosas grandes?"
- **Visual sugerido:** Animación de una persona pidiendo una función simple y viendo cómo la pantalla se llena de errores rojos porque la IA "olvidó" lo anterior o tocó archivos que no debía.
- **Mensaje clave:** La IA es un genio con déficit de atención. Necesita una estructura de trabajo profesional. Presentación de **Gentle Shell**.

### Bloque 2: La Cuadrilla de Construcción (1:15 - 3:00)
- **Tema:** "Dejar de usar una sola IA para todo: Bienvenidos los Especialistas."
- **Visual sugerido:** Presentar los personajes en estilo cómic o infografía animada:
  - El Arquitecto (el Gentleman).
  - El Explorador con lupa (`gentle-ai-explore`).
  - El Constructor con casco (`gentle-ai-worker`).
  - El Inspector con portapapeles (`gentle-ai-verify`).
- **Mensaje clave:** Cada uno tiene una sola misión y límites estrictos. Nadie pisa el trabajo del otro.

### Bloque 3: El Tribunal de los 4 Ojos y Judgment Day (3:00 - 4:15)
- **Tema:** "¿Cómo aseguramos que el código sea seguro y no se caiga a pedazos?"
- **Visual sugerido:** Dos jueces en un tribunal analizando un plano a ciegas (Auditoría doble ciega). Explicación rápida de las 4R (Riesgo, Confiabilidad, Resiliencia y Claridad).
- **Mensaje clave:** Dos opiniones independientes siempre ven más que una sola.

### Bloque 4: La Torre de Control y la Memoria Infinita (4:15 - 5:45)
- **Tema:** "El Supervisor: ¿Cómo evitamos la amnesia de la IA?"
- **Visual sugerido:** Un velocímetro de memoria que llega a la zona amarilla; el supervisor pausa todo, guarda la libreta de bitácora en Engram y abre una ventana nueva limpia sin perder ni un dato.
- **Mensaje clave:** Con el supervisor, los proyectos grandes no se rompen por fatiga de contexto.

### Bloque 5: Conclusión y El Futuro del Trabajo con Agentes (5:45 - 6:30)
- **Tema:** "El cambio de paradigma: De hablar con un chatbot a dirigir una empresa de software autónoma."
- **Llamado a la acción:** Reflexión final sobre cómo la disciplina y los procesos convierten a la IA en una herramienta verdaderamente profesional y confiable.
