# Plan: autocompletado y Next Edits

Fecha: 2026-10-14. Estado: **aprobado por el usuario; implementacion realizada, verificacion de modelo real pendiente**.

Base: [investigacion y fuentes](investigacion-autocompletado-next-edits.md). La primera entrega fue solo documental; el usuario autorizo despues la implementacion. Este documento conserva el plan aprobado. Consultar los [resultados de implementacion](resultados-implementacion.md) para distinguir lo ejecutado de los gates pendientes.

## 1. Objetivo y decisiones propuestas

Mejorar la continuacion de codigo en el cursor y anadir, como funcionalidad principal, prediccion de la siguiente edicion dentro del archivo activo. El usuario debe ver que cambiara y conservar el control de aceptar, rechazar y deshacer.

| Decision para aprobar | Recomendacion |
| --- | --- |
| Plataforma | API estables; mantener VS Code >= 1.90.0 salvo incompatibilidad demostrada |
| Alcance NES inicial | Archivo activo, una edicion contigua por propuesta, incluso lejos del cursor si aparece en el contexto enviado |
| Interfaz | Indicacion discreta del rango, comando para navegar, preview diff y acciones aceptar/rechazar |
| Activacion inicial | `nextEdits.enabled = false`; comando manual al habilitarlo; automatico opcional tras validar el MVP |
| Tab | Integracion opcional, desactivada por defecto; sin interceptar Tab globalmente |
| Modelo | Reutilizar el modelo configurado y el transporte chat; medir antes de cambiar defaults |
| FIM nativo | Fuera del MVP hasta verificar soporte del backend/modelo y necesidad real |
| Seguridad | Nunca autoaplicar, autoguardar, ejecutar codigo ni aceptar cambios obsoletos |

Fuera de alcance: agente/chat, cambios multifichero, indexacion/embeddings, entrenamiento, parser por lenguaje, motor de parches difusos, UI identica a Copilot y adaptador de API propuesta. El contexto de archivos abiertos adicionales y las sugerencias basadas en diagnosticos quedan para una iteracion posterior.

## 2. Contratos y arquitectura minima

### Autocompletado

Conservar `InlineCompletionItemProvider`. La solicitud representa un hueco entre prefijo y sufijo; el documento se trata como datos, no como instrucciones de conversacion. La respuesta contiene exclusivamente la continuacion insertable o vacio. Los comentarios pueden orientar codigo, pero no deben transformar la respuesta en una explicacion.

Separar construccion de mensajes y normalizacion como funciones comprobables sin Extension Host cuando sea posible. No cambiar simultaneamente transporte, modelo y prompt: comparar contra el mismo baseline para saber que aporta cada cambio.

- Preservar indentacion, whitespace significativo y EOL del documento. No aplicar `trim()` indiscriminado.
- Limitar limpieza a wrappers y ecos inequivosocos, con casos de regresion. No rechazar palabras naturales sin contexto: Markdown, cadenas y comentarios tambien son contenido valido.
- Hacer explicito y coherente el rango en respuestas nuevas y cacheadas. Admitir reemplazo de palabra solo si cumple el contrato estable y se prueba; no convertir esta ruta en NES.
- Con IntelliSense visible, construir una continuacion sobre su opcion seleccionada y devolver su mismo rango; si no es compatible, abstenerse.
- Invalidar cache por revision de configuracion y contexto relevante, incluida seleccion de IntelliSense. Limitarla a una entrada, sin cache persistente.
- Antes de devolver cualquier resultado, verificar URI, version, configuracion, cancelacion y solicitud vigente. Respuestas antiguas no sustituyen resultados nuevos.

### Prediccion de Next Edits

Registrar cambios del documento activo con snapshot anterior y actual, offsets de los eventos y version. Conservar un historial pequeno en memoria. Un evento puede incluir multiples cambios: interpretarlos respecto al snapshot previo, no modificar offsets secuencialmente sin ordenarlos o validar. No se necesita una biblioteca de diff para reconstruir eventos ni una busqueda global.

Enviar en una solicitud especifica: lenguaje, ruta relativa, ventana actual de codigo, cursor y cambios recientes relevantes. Las instrucciones NES piden la siguiente edicion relacionada, no completar el hueco del cursor ni reescribir el archivo. Una invocacion sin historial puede devolver ninguna propuesta; no inventar intencion.

Contrato de respuesta propuesto, deliberadamente pequeno:

```json
{"edit":{"oldText":"return user.name;","newText":"return user.displayName;"}}
```

```json
{"edit":null}
```

`oldText` debe ser no vacio y aparecer exactamente una vez en la ventana autorizada del snapshot. El cliente calcula el rango usando esa coincidencia y el offset de origen de la ventana. El modelo no decide URI, comandos ni coordenadas. Una insercion conserva un ancla existente en `oldText` y en `newText`; un borrado puede tener `newText` vacio. Un archivo vacio sigue siendo caso de autocompletado, no NES sin ancla.

Validar con `JSON.parse` y comprobaciones explicitas de forma, tipos y limites. Rechazar JSON truncado, campos desconocidos, varias ediciones, coincidencias ambiguas, ausencia del ancla, cambios identicos y resultados excesivos. No ejecutar contenido ni reparar patches con expresiones regulares. No exigir `response_format` al backend sin probar su compatibilidad; tampoco reintentar automaticamente respuestas invalidas.

El candidato interno conserva identificador, URI, version base, revision de configuracion, rango calculado, `oldText` y `newText`. No se persiste. La vigencia depende del snapshot completo, no solo de que el ancla siga existiendo.

### Presentacion y aplicacion

1. Mostrar el rango propuesto con decoracion de tema y una accion discreta de disponibilidad. No modificar el documento para simular ghost text. Para inserciones, marcar el ancla y el destino calculado.
2. `Go To Next Edit` revela el destino sin aplicar. `Preview Next Edit` abre un diff entre dos snapshots virtuales de solo lectura, con el cambio ya validado. No abrir un diff automaticamente al teclear.
3. `Accept Next Edit` recupera el editor fuente, comprueba de nuevo version, URI, configuracion y texto original, y aplica una unica sustitucion con `TextEditor.edit`, separada por limites de undo. Verificar el booleano de resultado. Si hubo un `await` para abrir el editor, revalidar despues y justo antes de construir la edicion.
4. `Reject Next Edit` o Escape contextual elimina la propuesta sin tocar el buffer. Un solo Undo revierte toda la aceptacion; Redo la restaura. No guardar el archivo.
5. No generar sugerencias sobre los documentos virtuales. Mantener el candidato al abrir su propio preview, pero invalidarlo al cambiar el documento fuente o pasar a otro archivo real. El preview nunca se convierte en el destino de aceptacion.

Comandos propuestos: `cliproxyInline.triggerNextEdit`, `cliproxyInline.goToNextEdit`, `cliproxyInline.previewNextEdit`, `cliproxyInline.acceptNextEdit` y `cliproxyInline.rejectNextEdit`. Reutilizar la barra de estado y los menus del editor; no crear paneles o webviews. Si hay acciones en hover, usar IDs de candidatos y una lista cerrada de comandos, nunca enlaces o comandos devueltos por el modelo.

### Limites y scheduling

Valores iniciales para medir, no promesas del backend ni un gran catalogo de ajustes:

| Recurso | Limite propuesto |
| --- | --- |
| Historial | Solo documento activo; hasta 16 eventos y 60 segundos; limpiar al deshabilitar/cerrar |
| Contexto total de solicitud | Hasta 24 000 caracteres UTF-16, incluido historial; conservar limites de linea y no partir pares sustitutos |
| Historial dentro de ese presupuesto | Hasta 6 000 caracteres; eliminar primero lo mas antiguo |
| Edicion propuesta | Hasta 64 lineas y 8 000 caracteres en cada lado de la sustitucion |
| Respuesta NES | Presupuesto de salida propio y acotado, inicialmente 1 024 tokens; no reutilizar ciegamente los 256 del completado |
| Debounce NES automatico | 800 ms como punto de partida, independiente de los 300 ms del completado |
| Concurrencia local | Una peticion vigente; cancelar/sustituir las obsoletas y descartar respuestas tardias |

Estos caracteres no son tokens. Para archivos pequenos enviar el archivo completo si cabe junto con el historial. Para archivos grandes, enviar una ventana contigua alrededor de la edicion reciente o cursor, con origen conocido. Las propuestas fuera de esa ventana quedan fuera de alcance; no prometer encontrar todos los usos del archivo. El prefijo/sufijo de autocompletado siguen respetando los ajustes actuales, bajo el limite total.

Autocompletado tiene prioridad frente a NES automatico. Una solicitud NES manual es una accion explicita y puede cancelar la peticion anterior. Tras aceptar, registrar el cambio como contexto para la siguiente prediccion, pero no encadenar solicitudes automaticas sin otra accion del usuario en el MVP. Undo/Redo invalidan propuestas y no disparan por si solos una nueva prediccion automatica. Tras rechazar, no repetir el mismo candidato para la misma version.

Configuracion nueva minima: `cliproxyInline.nextEdits.enabled`, `cliproxyInline.nextEdits.automatic` y `cliproxyInline.nextEdits.tabNavigation`, inicialmente `false`. Empezar con los presupuestos como constantes probadas; exponer mas ajustes o un modelo NES independiente solo si las mediciones lo justifican. El interruptor general y el filtro de lenguajes existentes gobiernan ambos recorridos.

Solo operar en documentos editables admitidos, con una unica seleccion/cursor y workspace confiable. Excluir preview, output, secretos evidentes como `.env`/claves privadas y esquemas no autorizados; definir y probar la lista concreta. No ampliar a otros archivos o carpetas. Las exclusiones no garantizan detectar todos los secretos y deben documentarse como tales. No registrar codigo, prompts completos, respuestas crudas ni claves; redactar tambien detalles de errores HTTP.

## 3. Fases y puntos de control

| Fase | Trabajo | Prueba de salida |
| --- | --- | --- |
| 0. Baseline pequeno | Anadir runner unitario con `node:test`, fixtures de texto y servidor HTTP falso reutilizable. Separar helpers de runtime solo donde sea necesario para probarlos | Reproducir rango de cache, sanitizacion y payload actual sin usar red externa |
| 1. Contrato de completado | Aclarar tarea/datos, mejorar contexto y limpieza conservadora; coherencia de rangos/cache; IntelliSense y guardas de vigencia | Pruebas unitarias y Extension Host del slice; comparacion A/B inicial con el mismo modelo |
| 2. NES manual, prioridad funcional | Captura acotada de cambios, solicitud independiente, parser/validador de una sustitucion y candidato versionado | Rename y cambio estructural producen una propuesta fuera del cursor con backend falso; ninguna edicion sin aceptar |
| 3. Recorrido utilizable | Decoracion, navegar, diff virtual, aceptar, rechazar, undo/redo y limpieza de recursos | Flujo completo en Extension Host sobre buffer sin guardar, incluyendo cambio concurrente |
| 4. Automatizacion opcional | Debounce NES, arbitraje con completado, cancelacion y supresion de repetidos; opcion Tab en dos pasos | Rachas de escritura, respuestas fuera de orden y conflictos de teclado sin modificar codigo por si solos |
| 5. Validacion y entrega | Evaluacion con backend real, ajustes guiados por datos y documentacion de uso/limites | Gates de seguridad y calidad siguientes; instalacion VSIX en minima soportada y estable vigente |

Cada fase debe tener un cambio pequeno y su prueba focal antes de avanzar. La fase 1 no debe convertirse en una reescritura general que retrase NES. Las fases 2 y 3 constituyen la primera entrega funcional de Next Edits. Si las API estables no satisfacen la experiencia requerida, detenerse para decidir con el usuario antes de adoptar propuestas o cambiar el minimo de VS Code.

## 4. Archivos afectados al implementar

| Superficie existente | Cambio previsto |
| --- | --- |
| [src/cliProxyClient.ts](../src/cliProxyClient.ts) | Reutilizar HTTP y errores; separar contratos de completado y NES; mantener cancelacion |
| [src/completionText.ts](../src/completionText.ts) | Limpieza conservadora probada, EOL y whitespace |
| [src/inlineCompletionProvider.ts](../src/inlineCompletionProvider.ts) | Contexto, rangos, IntelliSense, cache y vigencia |
| [src/config.ts](../src/config.ts) | Opciones NES y validacion de presupuestos/valores relevantes |
| [src/extension.ts](../src/extension.ts) | Registro y disposicion del controlador, preview, eventos y comandos |
| [package.json](../package.json) | Comandos, menus, opciones, atajos condicionados y scripts de tests |
| [tsconfig.json](../tsconfig.json) | Solo cambios necesarios para comprobar helpers/pruebas sin introducir imports de VS Code en tests puros |
| [README.md](../README.md) y [CHANGELOG.md](../CHANGELOG.md) | Uso real, diferencias con Copilot, opt-in, privacidad y limitaciones |
| [.vscodeignore](../.vscodeignore) | Excluir fixtures y artefactos de test si procede; verificar el contenido del VSIX |

Modulos nuevos solo donde haya responsabilidad nueva: un nucleo NES con historial acotado y validacion comprobable sin VS Code, y un controlador para eventos, scheduling y presentacion. Separar preview en otro modulo solo si evita complejidad real. Un directorio de pruebas con fixtures pequenas; sin framework de agentes, buses genericos ni sistema de plugins. Los nombres definitivos se decidiran al implementar.

## 5. Plan de pruebas

### Unitarias y de transporte, deterministas

Usar `node:test` y `node:assert/strict`, compilando TypeScript si procede. Reutilizar un unico servidor falso para controlar payload, retrasos, errores y cancelacion. No depender de respuestas de un LLM para aprobar estas pruebas.

| ID | Caso | Resultado exigido |
| --- | --- | --- |
| A1 | Funcion incompleta, mitad de identificador, cursor antes de `)` o `}` | Continuacion sin repetir prefijo/sufijo; contexto en orden correcto |
| A2 | Comentario local orientativo frente a documento que contiene instrucciones de chat | Payload separa tarea y datos; fixtures de respuesta no se convierten en prosa insertada por una limpieza agresiva |
| A3 | Fences de envoltorio frente a fences reales de Markdown, cadenas y comentarios | No destruir contenido legitimo; solo quitar wrappers inequivosocos |
| A4 | Indentacion, whitespace final significativo, LF/CRLF, Unicode y solapamientos pequenos | Preservar texto valido y evitar duplicacion sin cortar tokens necesarios |
| A5 | Cache acertada/fallida; cambio de modelo/prompt/seleccion | Mismo rango y semantica; no reutilizar resultados de otro contexto |
| A6 | Respuestas vacias, tipadas por partes, malformadas o truncadas | Ninguna sugerencia corrupta; comportamiento definido y error sin contenido sensible |
| N1 | Reemplazo, insercion con ancla, borrado y `edit: null` | Candidato correcto o abstencion sin modificar buffer |
| N2 | Ancla repetida, ausente, vacia o fuera de ventana | Rechazar; sin busqueda difusa ni aplicar en otra ubicacion |
| N3 | JSON invalido, varias ediciones, campos extra, cambio identico o demasiado grande | Rechazar sin reintentos automaticos |
| N4 | Multiples cambios en un evento, pegado, presupuestos e historial expirado | Snapshot y offsets correctos; memoria y solicitud acotadas |
| C1 | Cancelacion durante debounce/HTTP, timeout y respuesta antigua que llega despues | Cero presentaciones/aplicaciones obsoletas; timers y listeners liberados |
| C2 | 401/429/500, proxy caido, cabeceras opcionales | Fallo controlado sin bucle, secretos en logs ni notificaciones por cada pulsacion |
| C3 | Prioridad completado/NES, rechazo repetido, cambio de configuracion | Solo solicitud vigente; no spam ni reapertura del mismo candidato |

### Integracion en Extension Host

Anadir el harness oficial de pruebas de extensiones con `@vscode/test-electron`; usar un runner pequeno en Node para los casos de Extension Host, sin dependencia de runtime nueva en la extension. Fuente de referencia: [Testing Extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension). En Linux sin pantalla puede necesitar Xvfb. Ejecutar contra 1.90.0 y estable vigente; no asumir que los tipos instalados recientes validan el minimo.

| ID | Recorrido | Resultado exigido |
| --- | --- | --- |
| V1 | Solicitud de completado dentro de palabra, nueva y cacheada | Rangos identicos y aceptacion sin sustituir accidentalmente texto existente |
| V2 | Opcion de IntelliSense seleccionada | Mismo rango y continuacion que extiende el texto seleccionado, o abstencion |
| V3 | Editar una declaracion y proponer actualizar otro uso lejano | Navegar revela el rango correcto; el buffer no cambia al mostrarlo |
| V4 | Preview y aceptacion sobre documento sucio | Diff exacto y de solo lectura; aplicar al fuente, no al virtual; no guardar |
| V5 | Escribir, Undo/Redo o cambiar configuracion durante peticion/preview/aceptacion | Invalidacion y cero cambios sobre una version obsoleta |
| V6 | Aceptar, Undo y Redo | Una sola operacion reversible, sin perder cambios previos del usuario |
| V7 | Rechazar, cerrar fuente, cambiar archivo, deshabilitar y desactivar extension | Decoraciones, estado, buffers virtuales y recursos se limpian |
| V8 | Documento excluido, no confiable, no editable, virtual o con multiples cursores | Sin peticiones automaticas ni cambios; tampoco por comandos fuera de contexto |
| V9 | Automatizacion tras tecleo y aceptacion | Debounce y prioridad correctos; sin cadena de solicitudes autoalimentada |

Las pruebas de invocacion del proveedor no prueban por si solas el renderizado ni el enrutamiento de teclas. Verificarlos tambien en una sesion real del editor. No ampliar la API publica de la extension solo para testear; usar un punto de inyeccion pequeno para transporte donde haga falta.

### Interaccion manual

Comprobar en Linux y documentar lo no cubierto en otros sistemas. Usar TypeScript/JavaScript, Python como texto de fixture y Markdown. Verificar tema claro/oscuro, zoom, teclado y lectura del destino sin depender solo del color.

Para Tab opcional, primer paso solo navega y segundo acepta. Condicionar a candidato vigente y foco del editor; excluir `inlineSuggestionVisible`, `suggestWidgetVisible`, `inSnippetMode`, seleccion multiple, solo lectura, modo de Tab para mover foco y otros widgets. Si no puede evitarse un conflicto con Copilot/Vim u otros atajos, mantener comandos explicitos sin Tab. Escape solo descarta la propuesta propia cuando corresponde. No cambiar ajustes ni atajos globales del usuario.

### Calidad con el modelo real

Proponer un corpus pequeno de 12 escenarios de continuacion y 8 de NES, con tres repeticiones por variante: 36 + 24 respuestas. Comparar baseline y propuesta con el mismo modelo, parametros y contexto autorizado; usar archivos sinteticos, nunca secretos. Solicitar ejecucion controlada del backend real una vez aprobado el plan, no enviar codigo privado por defecto.

Casos NES: rename parcial de metodo y variable, Point a Point3D, cambio de firma, adaptacion de llamada, correccion tipografica relacionada, borrado de una referencia y ausencia de cambio necesario. No exigir texto identico: revisar si el siguiente cambio es util, localizado y consistente con la intencion.

Registrar manualmente para el corpus: respuesta conversacional/fuera de formato, duplicacion, validez de la insercion, candidato valido, utilidad revisada, abstencion correcta y latencias p50/p95. Separar tiempo del backend de debounce, validacion y presentacion. Los mocks prueban seguridad y contratos; no prueban calidad predictiva.

Objetivos iniciales para aprobar, revisables antes de implementar: al menos 90% de continuaciones sin prosa ajena ni duplicacion, sin empeorar el baseline; al menos 70% de propuestas NES utiles en escenarios que requieren cambio, y abstencion en todos los controles sin cambio necesario. Son metas del corpus, no garantias de produccion. Si fallan, revisar contrato/modelo con datos antes de anadir contexto o mas heuristicas.

Objetivo de rendimiento local: en el corpus acotado, overhead p95 de construccion/validacion/presentacion menor de 50 ms, excluyendo red y debounce; medir en la maquina de prueba. Cero peticiones por pulsacion durante una racha mas corta que el debounce. Informar latencia total observada del backend, sin prometer un limite que no se ha medido.

## 6. Gates y aprobacion

Para cada cambio: prueba focal del comportamiento tocado, luego compilacion y pruebas relacionadas. Scripts previstos, aun no existentes salvo `compile`: `npm run test:unit`, `npm run test:integration` y `npm run compile`. Antes de entregar, ejecutar `npm run package`, revisar el contenido e instalar el VSIX en el entorno de prueba. No publicar ni cambiar version sin acordarlo.

Condiciones obligatorias: ninguna edicion sin aceptacion, ninguna edicion obsoleta aplicada, Undo correcto, preview fiel, limites de contexto respetados, sin contenido sensible en logs y compatibilidad minima comprobada. Si una prueba de editor o backend no se puede ejecutar, indicar exactamente que queda sin verificar; no sustituirla por una compilacion exitosa.

Decisiones aprobadas al continuar: API estables, archivo activo y automatizacion/Tab opcionales. La autorizacion del usuario permitio implementar sin ampliar ese alcance. La evaluacion del modelo real y las comprobaciones manuales que no puedan automatizarse deben constar como pendientes, no como gates superados.
