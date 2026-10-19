# Plan: NES casi nunca se dispara

Fecha: 2026-10-17. Estado: propuesta, sin implementar. Base: [plan anterior](plan-implementacion-pruebas.md) y [resultados](resultados-implementacion.md).

## 1. Problema

Con Next Edits activado, casi nunca aparece una propuesta. La visibilidad de la propuesta no es el problema y queda fuera de alcance. El objetivo es que NES se dispare cuando corresponde y que, cuando no proponga nada, se sepa por que.

## 2. Diagnostico por lectura de codigo

| # | Causa | Evidencia | Efecto | Confianza |
| --- | --- | --- | --- | --- |
| 1 | NES automatico se descarta si hay un autocompletado en curso y no se reintenta | [requestCoordinator.ts](../src/requestCoordinator.ts#L7-L9), [nextEditController.ts](../src/nextEditController.ts#L161-L164) | Tras el ultimo tecleo, el autocompletado espera 300 ms y luego al modelo. A los 800 ms sigue en curso salvo que el modelo responda en menos de ~500 ms, asi que NES automatico casi nunca arranca | Alta |
| 2 | Iniciar un autocompletado cancela el NES en curso, incluso con acierto de cache | [inlineCompletionProvider.ts](../src/inlineCompletionProvider.ts#L76) se ejecuta antes de la cache en [L89](../src/inlineCompletionProvider.ts#L89); [requestCoordinator.ts](../src/requestCoordinator.ts#L10) | Cualquier nueva invocacion del proveedor mata una prediccion NES lenta | Alta |
| 3 | Mover el cursor cancela la peticion e invalida el resultado | [nextEditController.ts](../src/nextEditController.ts#L61), [nextEditController.ts](../src/nextEditController.ts#L202-L206) | Con modelos de varios segundos, basta un clic o una flecha para perder la propuesta, aunque el documento no haya cambiado | Alta |
| 4 | Los descartes automaticos no se muestran ni se registran | [nextEditController.ts](../src/nextEditController.ts#L157-L178), [report](../src/nextEditController.ts#L196-L200) | Imposible distinguir "no se pidio", "se cancelo", "JSON invalido" o "el modelo no propuso nada" | Alta |
| 5 | JSON envuelto en un bloque de codigo se rechaza; un test lo exige | [nextEdit.ts](../src/nextEdit.ts#L112), [unit.test.cjs](../tests/unit.test.cjs#L100) | Modelos que responden con un bloque `json` pierden todas sus propuestas | Media, depende del modelo |
| 6 | La respuesta truncada (`finish_reason: length`) se convierte en vacio sin aviso | [cliProxyClient.ts](../src/cliProxyClient.ts#L57-L61), [presupuesto](../src/cliProxyClient.ts#L118), [reasoning](../src/cliProxyClient.ts#L120) | Con `reasoning_effort`, el razonamiento puede agotar los 1 024 tokens | Hipotesis |
| 7 | El historial guarda cada pulsacion por separado y usa offsets numericos | [nextEdit.ts](../src/nextEdit.ts#L34-L40), [limite de 16](../src/nextEdit.ts#L54), [payload](../src/nextEdit.ts#L61-L67) | El modelo ve letras sueltas y offsets que no sabe interpretar; responde `{"edit":null}` | Media |
| 8 | El ancla exige coincidencia exacta de espacios | [nextEdit.ts](../src/nextEdit.ts#L125-L127) | Diferencias de tabulacion o espacios finales descartan la propuesta | Hipotesis; medir antes de cambiar |
| 9 | Configuracion | `nextEdits.automatic` es `false` por defecto; `cliproxyInline.enabled` tambien apaga NES | Sin `automatic`, NES solo se dispara por comando | Verificar |

El test del adaptador que cubre NES automatico ([editor.test.cjs](../tests/editor.test.cjs#L270-L282)) no tiene un autocompletado en curso, por eso no detecta las causas 1 y 2.

## 3. Criterios de aceptacion

- Backend falso: tras una pausa de 800 ms con un autocompletado lento en curso, se envia la peticion NES automatica cuando ese autocompletado termina. Determinista en tests.
- Mover el cursor durante una peticion NES no descarta un resultado valido para la misma version del documento.
- Cada intento NES produce exactamente una linea de log con resultado y latencia, sin codigo, prompts ni respuestas.
- Modelo real: se compara la distribucion de resultados antes y despues sobre los mismos escenarios. No se promete una tasa de calidad concreta.
- Sin regresiones: el autocompletado conserva prioridad, los resultados obsoletos por cambio de documento se siguen descartando y pasan todas las pruebas en VS Code estable y 1.90.0.

## 4. Fases

Cada fase es un cambio pequeno con su prueba antes de pasar a la siguiente.

### Fase 1. Medir

- `parseNextEdit` devuelve el motivo del rechazo en lugar de `undefined`.
- `fetchNextEdit` expone `finish_reason` para distinguir truncado de vacio.
- Una linea `info` por intento en el canal de salida: resultado, latencia en ms y si fue automatico. Resultados: `disabled`, `no-history`, `busy`, `cancelled`, `stale`, `http-error`, `truncated`, `invalid-json`, `invalid-shape`, `anchor-missing`, `anchor-ambiguous`, `null`, `repeated`, `ok`.
- Tests: cada motivo del parser y ausencia de contenido del documento en los logs.
- Salida: el usuario ejecuta los escenarios de la seccion 6 con su modelo y se obtiene la distribucion base.

### Fase 2. Disparo (correccion principal)

- `RequestCoordinator` con dos canales independientes: un autocompletado nuevo cancela solo el autocompletado anterior y un NES nuevo cancela solo el NES anterior. Como maximo hay uno de cada en vuelo.
- NES automatico no se descarta si hay un autocompletado en curso: espera a que termine (limitado por `requestTimeoutMs`), comprueba que la version del documento no cambio y entonces pide.
- Mover el cursor ya no cancela la peticion ni invalida el resultado. Se valida version, configuracion y texto anclado. Mover el cursor sigue reiniciando el temporizador de 800 ms.
- Un cambio en el documento sigue cancelando NES y descartando resultados obsoletos.
- Tests en el adaptador: autocompletado retenido y NES automatico que se envia al liberarlo; cursor movido durante NES conserva la propuesta; acierto de cache del autocompletado no cancela NES.
- README: sustituir "yields to inline completion requests" por la nueva semantica.

### Fase 3. Respuesta robusta

- Aceptar un unico bloque de codigo `json` que envuelva toda la respuesta, con solo espacios fuera. El esquema sigue siendo estricto. Actualizar el test que hoy lo rechaza.
- Si la fase 1 muestra `truncated` frecuente, subir el presupuesto NES o usar menor esfuerzo para NES (fase 5).
- No hacer coincidencia difusa del ancla. Solo si `anchor-missing` domina, valorar normalizar finales de linea y espacios finales, con tests.

### Fase 4. Contexto util para el modelo

- Agrupar ediciones contiguas consecutivas (escribir o borrar en el mismo punto) en una sola entrada. Escribir `displayName` sobre `name` debe producir una entrada, no once.
- Enviar historial y cursor como lineas (numero de linea, texto anterior y nuevo) en lugar de offsets. El offset de la ventana se conserva solo internamente.
- Ajustar el prompt NES a ese formato sin cambiar el contrato de salida.
- Tests: agrupacion, expiracion y limites de presupuesto.
- Salida: comparar la tasa de `null` con la base de la fase 1, mismo modelo y escenarios.

### Fase 5 (opcional). Modelo NES independiente

- `cliproxyInline.nextEdits.model` y `cliproxyInline.nextEdits.reasoningEffort`; vacios heredan los valores generales.
- Solo si los datos de las fases 1 y 4 muestran que, con buen contexto, la calidad la limita el modelo.

## 5. Decisiones pendientes

| Decision | Opciones | Recomendacion |
| --- | --- | --- |
| NES automatico con autocompletado en curso | Esperar a que termine / pedir en paralelo | Esperar: conserva la prioridad del autocompletado y evita doble carga |
| Bloque de codigo `json` | Aceptar / seguir rechazando | Aceptar, solo si envuelve toda la respuesta |
| Nivel del log NES | `info` / `debug` | `info`: `debug` esta oculto por defecto |
| Fase 5 | Ahora / tras medir | Tras medir |

## 6. Verificacion

```bash
npm run test:unit
npm run test:integration
VSCODE_TEST_VERSION=1.90.0 npm run test:integration
```

Escenarios manuales con modelo real, con `nextEdits.enabled` y `nextEdits.automatic` activos, repetidos antes y despues de cada fase:

1. Renombrar una funcion escribiendo el nombre nuevo; esperar propuesta en la llamada.
2. Anadir un parametro a una funcion; esperar propuesta en la llamada.
3. Renombrar una propiedad de un objeto usada mas abajo.
4. Cambiar un tipo y esperar el ajuste en un uso.
5. Eliminar un argumento y esperar su eliminacion en la llamada.

Registrar los recuentos de resultados del log, no el codigo.

## 7. Archivos afectados

| Archivo | Cambio |
| --- | --- |
| [src/requestCoordinator.ts](../src/requestCoordinator.ts) | Canales separados y espera de autocompletado en curso |
| [src/nextEditController.ts](../src/nextEditController.ts) | Log de resultados, no cancelar por cursor, validacion por version y ancla |
| [src/nextEdit.ts](../src/nextEdit.ts) | Motivos de rechazo, bloque `json`, agrupacion de historial, lineas |
| [src/cliProxyClient.ts](../src/cliProxyClient.ts) | `finish_reason` para NES, prompt NES con lineas |
| [src/config.ts](../src/config.ts) y [package.json](../package.json) | Solo en la fase 5 |
| [tests/unit.test.cjs](../tests/unit.test.cjs), [tests/editor.test.cjs](../tests/editor.test.cjs) | Pruebas de cada fase |
| [README.md](../README.md), [CHANGELOG.md](../CHANGELOG.md) | Semantica del disparo automatico y diagnostico |

## 8. Fuera de alcance

- Visibilidad o renderizado de la propuesta.
- Textos de ajustes y comandos que mezclan autocompletado y NES; se tratan aparte.
- Contexto de varios archivos, API propuestas y encadenar NES tras aceptar.
