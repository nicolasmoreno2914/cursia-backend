// Fixture del gate frontend (auto-test del escáner, M8c): cada fallo usa una construcción que el escáner debe
// detectar como código nuevo o expresión sin muestra.
async function _fixtureA(item) { return { ok: false, error: `brand_new_code: x`, retryable: true }; }
async function _fixtureB(item) { var m = "zz_new_code: y"; return { ok: false, error: m, retryable: true }; }
async function _fixtureC(item) { return fail(`tpl_new_code: z`, false); }
async function _fixtureD(item) { return { ok: false, error: "dq_new_code: w", retryable: false }; }
async function _fixtureE(item, e) { return failWithDraft(e.reason + ' algo', 'x'); }
async function _fixtureF(item) { await backendDynFail(item.itemRunId, 'ex', `bk_new_code: ${item.x}`, true); }
async function _fixtureG(item) { throw { examBankFail: true, msg: 'thrown_new_code: x' }; }
