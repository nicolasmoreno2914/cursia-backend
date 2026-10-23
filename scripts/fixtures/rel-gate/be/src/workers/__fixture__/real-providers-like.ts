// Fixture: `fail(<cualquier cosa>, item, …)` del worker de proveedores (antes solo se veía `fail(deps, …)`).
declare function fail(d: any, item: any, message: string, retryable: boolean): Promise<never>;
async function otherDepsName(d: any, item: any) {
  await fail(d, item, `zz_rp_code: x`, false);
}
