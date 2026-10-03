// Fixture del check-rel-failure-classes (auto-test del escáner, M8c): cada emisor esconde un código NUEVO o una
// construcción que el escáner no puede leer. El check exige que TODOS se detecten (código sin regla o sin resolver).
async function branchAssignment(scheduler: any, id: string, ex: string, x: boolean) {
  let why = 'videogen_paid_maybe_new: el envío pudo haberse cobrado';
  if (x) why = 'lease_expired';
  await scheduler.failItem(id, ex, why, true);
}

async function ternaryTemplate(scheduler: any, id: string, ex: string, x: boolean) {
  const m = x ? 'lease_expired' : `tpl_new_code_be: ${x}`;
  await scheduler.failItem(id, ex, m, true);
}

async function helperCall(scheduler: any, id: string, ex: string, helper: any) {
  await scheduler.failItem(id, ex, helper.build('x'), true);
}

async function parameterOnly(scheduler: any, id: string, ex: string, p: string) {
  await scheduler.failItem(id, ex, p, true);
}

async function partiallyDynamic(scheduler: any, id: string, ex: string, err: Error) {
  let msg = 'unexpected_error: x';
  if (err) msg = err.message;
  await scheduler.failItem(id, ex, msg, true);
}

// Fix round 2 (N1, casos baratos): desestructuración, parámetro con valor por defecto en una rama, alias / bind,
// llamada opcional, corchetes, spread y template con el código pegado a una interpolación.
async function destructured(scheduler: any, id: string, ex: string, o: any) {
  const { why } = o;
  await scheduler.failItem(id, ex, why, true);
}

async function paramDefault(scheduler: any, id: string, ex: string, msg: string) {
  if (!msg) msg = 'lease_expired';
  await scheduler.failItem(id, ex, msg, true);
}

async function aliasBind(scheduler: any, id: string, ex: string) {
  const f = scheduler.failItem.bind(scheduler);
  await f(id, ex, 'zz_alias_code: x', true);
}

async function optionalChain(scheduler: any, id: string, ex: string) {
  await scheduler?.failItem?.(id, ex, 'zz_optional_code: x', true);
}

async function bracketAccess(scheduler: any, id: string, ex: string) {
  await scheduler['failItem'](id, ex, 'zz_bracket_code: x', true);
}

async function spreadArgs(scheduler: any, args: any[]) {
  await scheduler.failItem(...args);
}

async function templateSuffix(scheduler: any, id: string, ex: string, s: string) {
  await scheduler.failItem(id, ex, `lease_expired${s}`, true);
}
