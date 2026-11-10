/**
 * r107 B3 fix round 2 (N2, decisión del coordinador): tope de SUBIDA del Taller de cursos — 200 MB (el diseño §11 decía
 * 300). Así todo original aceptado se puede diagnosticar dentro del presupuesto de memoria (200 MB × 5 = 1 GB). Lo usan
 * la creación de la sesión (DTO + servicio), la URL firmada de subida, el cierre de la subida (HEAD) y la descarga con
 * tope. El lector seguro (mbz-reader) conserva su límite genérico de 300 MB: también abre zips anidados.
 */
export const WORKSHOP_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
