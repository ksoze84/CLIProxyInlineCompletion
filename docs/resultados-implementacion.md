# Resultados de implementacion

Trabajo autorizado por el usuario tras revisar el [plan](plan-implementacion-pruebas.md). Fecha de inicio: 2026-10-14. No se ha cambiado la version ni publicado la extension.

## Funcionalidad

- Autocompletado con prefijo/sufijo serializados como datos, instrucciones especificas de continuacion y salida corta. No se afirma que sea FIM nativo.
- Limpieza conservadora, preservacion de whitespace y EOL, fences legitimos en Markdown, rangos explicitos identicos en cache, compatibilidad con la opcion seleccionada de IntelliSense y guardas de version/configuracion/cursor.
- Next Edits de un archivo: historial reciente en memoria, respuesta JSON separada y una sustitucion con ancla exacta unica. Admite reemplazar, insertar con ancla o borrar; no hace matching difuso ni aplica patches arbitrarios.
- Marcador y destino, comandos, preview diff con dos snapshots de solo lectura, aceptar/rechazar desde fuente o preview y Undo/Redo separado. Nunca autoaplica ni guarda.
- Automatizacion a 800 ms y Tab en dos pasos, ambas desactivadas por defecto. Prioridad de completado, cancelacion, supresion de candidatos rechazados y ausencia de cadenas automaticas tras aceptar.
- Elegibilidad por Workspace Trust, esquema, seleccion, lenguaje y exclusiones de nombres sensibles; errores sin cuerpos HTTP o contenido del modelo en logs.

## Alcance y decisiones

Se reutilizan transporte, configuracion y registro. No hay dependencia nueva de runtime: solo se anade `@vscode/test-electron` para desarrollo. Los modulos nuevos corresponden al nucleo NES, controlador, coordinacion de solicitudes y ventanas de texto compartidas. El runner es `node:test` y los fixtures son sinteticos.

Los presupuestos se comprueban incluyendo el JSON serializado, dejando margen para instrucciones. Para evitar snapshots desproporcionados se omite seguimiento NES por encima de dos millones de caracteres; no es una promesa de procesar archivos grandes completos. El historial representa cambios del mismo documento, no coordenadas globales reutilizables. Los candidatos dependen siempre de una version exacta.

La opcion `systemPrompt` sigue limitada al autocompletado para no romper el contrato JSON de NES. Cambiar modelo/prompt/configuracion invalida las sugerencias. Se usan un indicador de texto, borde y barra de estado en vez de implementar una flecha SVG propia o el renderer experimental de Copilot.

## Verificacion ejecutada

| Comprobacion | Resultado |
| --- | --- |
| `npm run test:unit` | 14 pruebas aprobadas, incluido un recorrido amplio con adaptador del editor |
| Compilacion TypeScript estricta | Aprobada |
| Diagnosticos del codigo fuente | Sin errores al finalizar los ajustes |
| Extension Host VS Code 1.90.0 | 9 recorridos aprobados: cache, IntelliSense, respuesta obsoleta, NES fuera del cursor, preview/aceptacion, Undo/Redo, invalidacion, rechazo y multicursor |
| Extension Host estable 1.142.0 | Los mismos 9 recorridos aprobados |
| Empaquetado VSIX | Generado correctamente; sin tests, dependencias de desarrollo, fuentes TypeScript ni mapas |
| Instalacion VSIX | Aprobada con la CLI interna en perfiles aislados de 1.90.0 y 1.142.0 |
| `git diff --check` | Sin problemas de whitespace |
| `npm audit --omit=dev --audit-level=high` | Cero vulnerabilidades de produccion |

Las pruebas unitarias incluyen JSON invalido/extra/truncado, anclas ausentes o ambiguas, presupuestos, historial con multiples cambios y expiracion, Unicode/CRLF, partes tipadas, errores redactados y cancelacion HTTP. El adaptador comprueba configuracion, preview exacto, aplicacion al fuente, limites de undo solicitados, rechazo, peticiones NES obsoletas y debounce sin bucles.

Las descargas de VS Code fallaron inicialmente por TLS; un intento posterior del harness oficial pudo descargarlas. El harness espera los eventos reales de seleccion del editor para no confundir movimientos pendientes del cursor con errores del proveedor. Las advertencias del workbench y DBus no son por si mismas resultados de las pruebas.

El paquete de prueba se genera en `/tmp/cliproxy-inline-completion-next-edits.vsix`, sin sobrescribir el VSIX original del repositorio. Durante la comprobacion de instalacion, el lanzador `bin/code` detecto el terminal remoto WSL y redirigio una instalacion a ese entorno, ignorando los directorios de aislamiento. El paquete quedo instalado tambien en la sesion remota, sin recargar la ventana ni habilitar NES. Las instalaciones aisladas se repitieron correctamente con Electron y la CLI interna, sin `VSCODE_IPC_HOOK_CLI`.

## Pendiente y riesgos

- El servidor `http://127.0.0.1:8317` no estaba disponible. No se ha medido calidad predictiva, comparacion A/B ni latencia p50/p95 con un modelo real; los objetivos del corpus del plan siguen pendientes.
- Las pruebas de Extension Host verifican documentos y comandos, no pulsaciones fisicas de Tab/Escape ni el aspecto visual con temas, zoom, accesibilidad, Copilot o Vim. Esa revision manual sigue pendiente.
- No se han certificado Windows, macOS, esquemas remotos especificos ni todas las condiciones de solo lectura. Workspace Trust y exclusions se cubren parcialmente en el adaptador; requieren tambien revision manual del producto.
- La auditoria completa informa nueve vulnerabilidades altas en herramientas/dependencias de desarrollo, incluyendo la cadena de empaquetado `@vscode/vsce` y transitivas. No estan incluidas como runtime en el VSIX. No se ejecuta una actualizacion masiva fuera del alcance aprobado.
- El proxy local puede enviar el contexto a servicios remotos. Las exclusiones no son un detector completo de secretos; prompts y filtros no garantizan obediencia del modelo ni calidad semantica.

No se considera cumplida la evaluacion de calidad del plan por el hecho de compilar o pasar fixtures. El siguiente paso de producto es arrancar/configurar CLIProxyAPI y ejecutar el corpus sintetico con el modelo elegido antes de activar automatizacion o distribuir una nueva version.