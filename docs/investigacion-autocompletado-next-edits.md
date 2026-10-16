# Investigacion: autocompletado y Next Edit Suggestions

Fecha de consulta: 2026-10-14. Estado: investigacion terminada; implementacion autorizada posteriormente por el usuario. Los hallazgos siguientes describen el estado previo a implementar; consultar los [resultados](resultados-implementacion.md) para el estado actual.

## 1. Conclusion

Hay dos problemas distintos: mejorar la continuacion de texto en el cursor y anadir prediccion de la siguiente edicion sobre codigo existente. Cambiar solo el prompt de autocompletado no implementa Next Edits.

Recomendacion KISS/lean: mantener CLIProxyAPI y las API estables de VS Code, corregir primero el contrato de autocompletado y entregar inmediatamente despues un Next Edits minimo para el archivo activo. Una propuesta por vez, con inserciones, borrados o reemplazos, navegacion, vista previa, aceptacion explicita y deshacer. Automatizar la prediccion solo despues de validar ese recorrido manual.

No se promete reproducir exactamente la interfaz ni la calidad de Copilot. La integracion nativa de ediciones inline usa propiedades que siguen apareciendo en una API propuesta; la calidad depende tambien del modelo y del backend.

## 2. Que hace Copilot

| Aspecto | Autocompletado / ghost text | Next Edit Suggestions (NES) |
| --- | --- | --- |
| Pregunta que resuelve | Que texto escribir a continuacion en el cursor | Donde y como editar despues del cambio reciente |
| Contexto relevante | Codigo anterior y posterior, lenguaje y contexto disponible | Codigo actual y cambios recientes que revelan la intencion |
| Resultado | Continuacion de una linea o bloque | Edicion de simbolos, una linea o varias lineas |
| Ubicacion | Posicion solicitada en el editor | Puede estar alejada del cursor |
| Interaccion documentada | Tab acepta; hay aceptacion parcial y alternativas | Indicador en el margen; Tab navega y otro Tab acepta |
| Ejemplo | Completar el cuerpo de una funcion | Tras convertir Point en Point3D, actualizar propiedades y calculos |

La documentacion oficial describe NES como prediccion tanto de la ubicacion como del contenido del siguiente cambio [S1, S2]. No equivale a un chat que reescribe el archivo ni a aplicar automaticamente todos los cambios relacionados. Los comentarios locales pueden orientar legitimamente una continuacion; el fallo que interesa evitar es responder conversacionalmente al documento como si fuera una solicitud de chat.

Copilot documenta que utiliza el archivo actual y archivos abiertos como contexto para sugerencias [S1]. Esto no obliga a implementar esa amplitud en el MVP ni demuestra que el backend de esta extension ofrezca el mismo contexto o entrenamiento. Los detalles internos del modelo y del servicio no se deducen de la interfaz del producto.

## 3. Diagnostico del repositorio

La revision se limita al recorrido que construye, solicita, limpia y devuelve las sugerencias, y a su configuracion y registro. No se modifico codigo ni se envio contenido del workspace a un modelo durante esta investigacion.

| Evidencia local | Consecuencia | Comprobacion propuesta |
| --- | --- | --- |
| [cliProxyClient.ts](../src/cliProxyClient.ts): `buildMessages` envia prefijo y sufijo en un mensaje `user` a `/v1/chat/completions` | Ya existe contexto a ambos lados; el problema no es ausencia total de sufijo. Los marcadores son texto en un chat, no FIM nativo | Capturar el payload con un servidor falso y comparar respuestas del modelo en casos de continuacion |
| El prompt pide codigo crudo, pero no separa expresamente instrucciones del editor y contenido no confiable del documento | Es plausible que comentarios o prosa se interpreten como ordenes de conversacion. No esta demostrado sin ejemplos reales | Fixtures con comentarios, Markdown, cadenas y texto que intenta dar instrucciones |
| [completionText.ts](../src/completionText.ts) elimina fences, prefijo de linea, solapamiento con hasta 200 caracteres del sufijo y espacios finales | No detecta de forma fiable respuestas conversacionales y puede eliminar texto o whitespace significativo | Casos de eco, coincidencias de un caracter, indentacion y fences que sean contenido legitimo |
| [inlineCompletionProvider.ts](../src/inlineCompletionProvider.ts): respuesta nueva con rango vacio explicito; cache con `InlineCompletionItem(text)` sin rango | El constructor sin rango usa la palabra actual. El contrato de insercion puede cambiar al acertar en cache | Solicitar dos veces dentro de una palabra y comparar rango y resultado al aceptar |
| La clave de cache usa URI, prefijo y sufijo, pero no configuracion ni `selectedCompletionInfo` | Puede reutilizar una respuesta de otro modelo, prompt o seleccion de IntelliSense | Cambiar configuracion o seleccion sin cambiar el documento |
| Hay debounce, timeout y cancelacion mediante `AbortController` | Buena base reutilizable, pero falta una guarda propia por version y solicitud vigente | Cambiar documento/configuracion mientras llega una respuesta retrasada |
| Se ignora `selectedCompletionInfo` y solo se ofrecen inserciones en el cursor | No se cumple expresamente el contrato de extension de la opcion seleccionada de IntelliSense | Comprobar rango compatible y texto que extienda la opcion seleccionada |
| No hay historial de ediciones, planificador NES, preview ni comandos de aplicar/rechazar | Falta el recorrido completo de Next Edits | Escenario de cambio reciente seguido de reemplazo en otra linea |
| [package.json](../package.json) solo define scripts de compilacion, empaquetado y publicacion | No hay una suite de pruebas declarada que proteja estos contratos | Anadir pruebas pequenas antes de cambiar el comportamiento |

Hipotesis principal, falsable: la combinacion de modelo conversacional, contrato de contexto ambiguo y limpieza heuristica explica parte de la sensacion de que el archivo es un prompt. Una prueba A/B con el mismo modelo y los mismos prefijos/sufijos puede refutarla. Si no mejora, habra que evaluar un modelo de completado o una ruta FIM real, no seguir acumulando instrucciones.

La inconsistencia de rango en cache es un hecho del codigo y la API; su impacto visual y al aceptar debe reproducirse en Extension Host. No se presenta como un fallo ya observado por el usuario.

## 4. Limites reales de las API

### 4.1 API estable

`InlineCompletionItem.range` debe empezar y terminar en la misma linea. `insertText` puede contener varias lineas: insertar un bloque no equivale a reemplazar un rango multilinea. El texto reemplazado debe ser prefijo del texto de filtrado para que se muestre la sugerencia. Esto impide tratar el proveedor estable como una API general de cambios arbitrarios [S3, S4].

Si existe `selectedCompletionInfo`, la sugerencia debe extender su texto y usar su mismo rango. No basta con insertar una continuacion incompatible en el cursor [S4].

Las API estables permiten una alternativa funcional:

- `onDidChangeTextDocument` para observar cambios y guardar un historial acotado en memoria.
- Decoraciones y `revealRange` para indicar el destino y navegar a el.
- `TextDocumentContentProvider` y `vscode.diff` para comparar snapshots sin editar el archivo [S7].
- `TextEditor.edit` para aplicar una sustitucion y controlar los limites de undo; verificar su resultado booleano [S3].
- Comandos y claves de contexto propias para aceptar/rechazar sin apropiarse globalmente de Tab [S8].

Esta alternativa no proporciona el renderizado inline nativo de NES, desplazamiento de codigo o panel lateral integrado de Copilot. Las preferencias `github.copilot.*` no habilitan esas funciones en un proveedor de terceros.

### 4.2 API propuesta

El archivo oficial `vscode.proposed.inlineCompletionsAdditions.d.ts` consultado contiene `InlineCompletionItem.isInlineEdit`, `showRange`, `jumpToPosition` y `uri`, entre otras ampliaciones [S5]. Es evidencia de que esas capacidades concretas no deben darse por disponibles en la API estable consultada.

La guia oficial indica Insiders, `enabledApiProposals`, declaraciones compatibles y restricciones para compartir/publicar extensiones con API propuestas [S6]. No son una base adecuada para la ruta publicable normal de esta extension. Actualizar solo los tipos no habilita una propuesta en el runtime.

El proyecto declara `engines.vscode: ^1.90.0` y `@types/vscode: ^1.90.0`. Los tipos efectivamente instalados son **1.134.0** y siguen documentando el rango de una sola linea, sin esas propiedades propuestas. Compilar con tipos recientes no demuestra compatibilidad con VS Code 1.90.0: el plan exige probar esa version minima y la estable vigente. No se propone subir el minimo sin una necesidad demostrada.

## 5. Chat, FIM y backend

FIM (fill-in-the-middle) predice el contenido entre un prefijo y un sufijo. Es una capacidad del modelo y de la ruta de inferencia, no el resultado automatico de escribir tokens con aspecto especial en `messages`. La publicacion de Codestral es un ejemplo documentado de un modelo orientado a generacion de codigo con FIM; no demuestra que este disponible en la instalacion del usuario [S10].

CLIProxyAPI documenta compatibilidad con protocolos de chat y otros proveedores [S9]. Las fuentes consultadas no establecen que **el servidor, la version y el modelo configurados aqui** soporten una ruta FIM, un parametro `suffix`, JSON Schema estricto o todos los parametros de OpenAI. Tampoco `/v1/models` garantiza esas capacidades por devolver un nombre.

Decision propuesta:

1. Primera entrega con la ruta de chat existente: contexto serializado como datos, instrucciones especificas de continuacion, ejemplos minimos si la comparacion los justifica y salida limitada al texto insertable. Esto es emulacion semantica de FIM, no FIM nativo.
2. Next Edits con solicitud y respuesta diferentes: codigo actual + cambios recientes, una sola sustitucion estructurada o ninguna. No reutilizar el contrato de insercion.
3. Evaluar una ruta/modelo FIM real solo si las pruebas no alcanzan la calidad acordada y se verifica compatibilidad. No introducir deteccion especulativa ni fallback silencioso por cada pulsacion.

Reforzar el prompt reduce ambiguedad, pero no elimina prompt injection ni garantiza que un modelo obedezca. Las defensas decisivas para ediciones son validar el resultado, limitar su alcance, comprobar vigencia y exigir aceptacion humana.

## 6. Alcance recomendado y riesgos

| Decision | Motivo |
| --- | --- |
| Un archivo y una edicion contigua por propuesta | Permite aprender del flujo sin un motor de parches ni transacciones multifichero |
| Historial reciente en memoria; contexto acotado por caracteres ademas de lineas | Limita costes, latencia y exposicion de contenido |
| Primera validacion manual, automatizacion opcional despues | Separa la calidad de la prediccion de los problemas de scheduling |
| Preview explicito; nunca autoaplicar ni autoguardar | Protege el trabajo sin guardar y deja el control al usuario |
| Descartar al cambiar version; no rebase ni busqueda difusa | Evita aplicar una edicion a texto diferente del que vio el modelo |
| Reutilizar transporte, configuracion y registro existentes | Evita frameworks, SDK adicionales y refactorizaciones ajenas |
| No enviar archivos abiertos adicionales por defecto | Mantiene privacidad y alcance; se podra evaluar despues con datos |

Un proxy local puede reenviar codigo a proveedores remotos. No debe describirse como inferencia local ni como garantia de privacidad. El plan limita lo enviado, respeta Workspace Trust, evita contenido y claves en logs, y no conserva historial en disco.

Se desconoce la latencia real del backend, el comportamiento del modelo elegido y si una cancelacion local detiene el calculo remoto. La propuesta mide estos puntos, sin prometer calidad o velocidad iguales a Copilot.

## 7. Fuentes y trazabilidad

Todas las fuentes se consultaron el 2026-10-14. Las paginas y la rama `main` pueden cambiar. Las afirmaciones del producto se apoyan en documentacion oficial; las decisiones de arquitectura anteriores son recomendaciones para este repositorio.

| ID | Fuente | Uso |
| --- | --- | --- |
| S1 | [VS Code: Inline suggestions](https://code.visualstudio.com/docs/editing/ai-powered-suggestions) | Diferencia ghost text/NES, navegacion, aceptacion, ejemplos y contexto |
| S2 | [GitHub: Code suggestions / Copilot in IDEs](https://docs.github.com/en/copilot/concepts/completions/code-suggestions) | NES predice ubicacion y contenido a partir de ediciones actuales |
| S3 | [VS Code API reference](https://code.visualstudio.com/api/references/vscode-api) | Contratos de edicion, decoraciones y documentos |
| S4 | [Declaraciones estables oficiales](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts) y tipos instalados 1.134.0 | Contraste de `InlineCompletionItem`, rango y `selectedCompletionInfo` |
| S5 | [inlineCompletionsAdditions: propuesta oficial](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.inlineCompletionsAdditions.d.ts) | `isInlineEdit`, `showRange`, `jumpToPosition`, `uri` |
| S6 | [VS Code: Using Proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api) | Insiders, opt-in y limitaciones de publicacion |
| S7 | [VS Code: Virtual Documents](https://code.visualstudio.com/api/extension-guides/virtual-documents) | Snapshots de solo lectura para preview |
| S8 | [VS Code: When clause contexts](https://code.visualstudio.com/api/references/when-clause-contexts) | Conflictos de Tab, IntelliSense, snippets y claves propias |
| S9 | [CLIProxyAPI: documentacion](https://help.router-for.me/) y [README oficial](https://github.com/router-for-me/CLIProxyAPI) | Compatibilidad general de protocolos, sin inferir FIM en el servidor instalado |
| S10 | [Mistral: Codestral, 2024-05-29](https://mistral.ai/news/codestral) | Ejemplo historico verificable de FIM; no recomendacion de disponibilidad o licencia actual |

Limites de consulta: el extractor no pudo recuperar la referencia completa de la API estable; sus contratos concretos se contrastaron con la herramienta de documentacion de VS Code y los tipos instalados. Una URL tentativa del blog de GitHub devolvio 404 y la antigua guia de code generation de Mistral redirigio a otro producto; ninguna se usa como evidencia. No se ha comprobado el servidor real ni ejecutado una evaluacion de modelos.

El siguiente paso sujeto a revision esta en el [plan de implementacion y pruebas](plan-implementacion-pruebas.md).
